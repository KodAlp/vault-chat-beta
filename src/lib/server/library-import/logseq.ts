import path from 'node:path';
import {
	indexKey,
	isAttachmentName,
	isMarkdownName,
	makePlan,
	mapOutsideCode,
	normalizeFrontmatter,
	peekSourceText,
	readSourceText,
	relativeLink,
	resolveSourceLink,
	rewriteMarkdownLinks,
	rewriteWikilinksWith,
	safeFileBase,
	safeFolderSegment,
	sourceHas,
	stringifyNote,
	tooDeepSkips,
	uniqueTarget,
	walkSource,
	withPrefix
} from './common';
import { MAX_UPLOAD_BYTES } from '../../import-extensions';
import type { DetectResult, ImportPlan, ImportWarning, PlanEntry, SkippedEntry, SourceAdapter, SourceTree, TransformCtx, TransformResult } from './types';

/**
 * Logseq (file-based graph) -> library notes.
 *
 * Layout assumed (Logseq's own): pages/*.md, journals/YYYY_MM_DD.md,
 * assets/*, logseq/config.edn. Everything else (logseq/bak copies,
 * whiteboards/, draws/) is ignored on purpose — logseq/bak holds stale
 * duplicates of the pages.
 *
 * Block-level content stays an outline (Markdown lists). What changes:
 * page properties -> YAML frontmatter, block ids are removed after being
 * recorded, block references/embeds are expanded to text + a link to the page
 * that owns the block, [[page]]/#tag become relative links to pages that exist.
 *
 * Assumptions I could not verify against a real graph: new-format file names
 * use ___ for namespaces (a___b.md) with percent-encoded specials; the legacy
 * dot format (a.b.md) is only honoured when config.edn says :file/name-format
 * :legacy; journal page TITLES (e.g. "Oct 5th, 2026") depend on the user's
 * :journal/page-title-format and are not parsed, so links to journal pages by
 * that title stay plain text (the ISO date and the file's date name do resolve).
 */

/** Library folder journals land in (Logseq journals are daily notes; "gunluk" = diary, matching the Turkish-first UI). */
export const JOURNAL_FOLDER = 'gunluk';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const PROP_LINE = /^\s*(?:-\s+)?([A-Za-z0-9_][A-Za-z0-9_.?/-]*)::(?:\s+(.*)|\s*)$/;
const BULLET = /^(\s*)(?:[-*+])\s+(.*)$/;
const TASK_OPEN = /^(TODO|DOING|NOW|LATER|WAITING|WAIT|IN-PROGRESS)\s+/;
const TASK_DONE = /^DONE\s+/;
const TASK_CANCELED = /^(CANCELED|CANCELLED)\s+/;

interface BlockInfo {
	/** Page display name. */
	page: string;
	/** Target rel (without prefix) of the page owning the block. */
	target: string;
	text: string;
}

interface LogseqState extends Record<string, unknown> {
	/** indexKey(page name | alias | ISO date) -> target rel (no prefix). */
	pageIndex: Map<string, string>;
	blocks: Map<string, BlockInfo>;
	attachmentRels: Set<string>;
	legacyNames: boolean;
}

interface LogseqExtra extends Record<string, unknown> {
	name: string;
	journal: boolean;
	/** Page-level properties parsed at plan time. */
	props: [string, string][];
	/** Index of the first line after the property block. */
	bodyStart: number;
}

/** Strips the markers that make no sense in a quoted/inlined block text. */
function cleanBlockText(s: string): string {
	return s
		.replace(TASK_OPEN, '')
		.replace(TASK_DONE, '')
		.replace(TASK_CANCELED, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Leading `key:: value` lines at the top of a page (with or without a "- " on the first one, and indented continuation lines). */
export function parsePageProperties(lines: string[]): { props: [string, string][]; next: number } {
	const props: [string, string][] = [];
	let i = 0;
	for (; i < lines.length; i++) {
		const m = PROP_LINE.exec(lines[i]);
		if (!m) break;
		props.push([m[1].toLowerCase(), (m[2] ?? '').trim()]);
	}
	// A blank line after the property block belongs to it.
	while (i < lines.length && lines[i].trim() === '') i++;
	return { props, next: i };
}

/** journals/2026_10_05 -> 2026-10-05; null for any other name. */
function journalIso(base: string): string | null {
	const m = /^(\d{4})_(\d{2})_(\d{2})$/.exec(base);
	return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Filename (without .md) -> page name. New format: ___ is the namespace separator and specials are percent-encoded. */
export function pageNameFromFile(base: string, legacy: boolean): string {
	let name = base;
	try {
		if (name.includes('%')) name = decodeURIComponent(name);
	} catch {
		// not valid percent-encoding: the file name is the name
	}
	name = name.replace(/___/g, '/');
	// Legacy graphs wrote a.b.md for a/b — but a dot is an ordinary character in new-format names,
	// so only trust it when the config says :legacy.
	if (legacy) name = name.replace(/\./g, '/');
	return name;
}

function splitList(v: string): string[] {
	return v
		.split(',')
		.map((s) => s.replace(/\[\[|\]\]/g, '').replace(/^#/, '').trim())
		.filter(Boolean);
}

function topDir(rel: string): string {
	return rel.split('/')[0];
}

async function detect(root: string, tree: SourceTree = walkSource(root)): Promise<DetectResult> {
	const warnings: ImportWarning[] = [];
	const hasConfig = sourceHas(root, 'logseq/config.edn');
	const inGraph = tree.files.filter((f) => topDir(f.rel) === 'pages' || topDir(f.rel) === 'journals');
	const md = inGraph.filter((f) => isMarkdownName(f.rel)).length;
	const org = inGraph.filter((f) => f.rel.toLowerCase().endsWith('.org')).length;
	if (org > 0) warnings.push({ code: 'orgSkipped', count: org });
	if (md > 0) return { match: true, confidence: hasConfig ? 0.95 : 0.7, warnings };
	if (inGraph.length === 0) {
		// A Logseq DB-version graph stores everything in SQLite; there is no pages/ to read, and
		// the app's databases are never opened here. Point at the Markdown export instead.
		const dbLike = tree.files.some((f) => /\.(sqlite3?|db)$/i.test(f.rel) || f.rel === 'logseq/db-version');
		if (hasConfig || dbLike) warnings.push({ code: 'logseqDbGraph' });
	}
	return { match: false, confidence: 0, warnings };
}

async function plan(root: string, tree: SourceTree = walkSource(root)): Promise<ImportPlan> {
	const configText = peekSourceText(root, 'logseq/config.edn', 256 * 1024) ?? '';
	const legacyNames = /:file\/name-format\s+:legacy/.test(configText);

	const entries: PlanEntry[] = [];
	const skipped: SkippedEntry[] = tooDeepSkips(tree);
	const pageIndex = new Map<string, string>();
	const blocks = new Map<string, BlockInfo>();
	const attachmentRels = new Set<string>();
	const used = new Set<string>();
	const idLine = new RegExp(`^\\s*id::\\s*(${UUID})\\s*$`);
	let attachments = 0;
	let orgSkipped = 0;

	for (const f of tree.files) {
		const top = topDir(f.rel);
		if (top === 'assets') {
			if (isAttachmentName(f.rel)) {
				attachments++;
				attachmentRels.add(f.rel);
			} else skipped.push({ rel: f.rel, reason: 'unsupported' });
			continue;
		}
		if (top !== 'pages' && top !== 'journals') continue;
		if (f.fromExcluded) continue;
		if (f.rel.toLowerCase().endsWith('.org')) {
			orgSkipped++;
			skipped.push({ rel: f.rel, reason: 'orgFile' });
			continue;
		}
		if (!isMarkdownName(f.rel)) {
			skipped.push({ rel: f.rel, reason: 'unsupported' });
			continue;
		}
		// hls__ pages are PDF-highlight bookkeeping (coordinates, not prose).
		if (path.posix.basename(f.rel).startsWith('hls__')) {
			skipped.push({ rel: f.rel, reason: 'unsupported' });
			continue;
		}
		if (f.size > MAX_UPLOAD_BYTES) {
			skipped.push({ rel: f.rel, reason: 'tooLarge' });
			continue;
		}

		let raw: string;
		try {
			raw = readSourceText(root, f.rel);
		} catch {
			skipped.push({ rel: f.rel, reason: 'unsupported' });
			continue;
		}
		const lines = raw.replace(/\r\n?/g, '\n').split('\n');
		const { props, next } = parsePageProperties(lines);
		const base = path.posix.basename(f.rel, path.posix.extname(f.rel));
		const journal = top === 'journals';
		const iso = journal ? journalIso(base) : null;
		const titleProp = props.find(([k]) => k === 'title')?.[1];
		// The file's own name decides the target (stable across title edits); a title:: only
		// changes how the page is called and found.
		const fileName = iso ?? pageNameFromFile(base, legacyNames);
		const name = iso ?? (titleProp || fileName);

		let target: string;
		if (journal) target = `${JOURNAL_FOLDER}/${safeFileBase(iso ?? base)}.md`;
		else {
			const segs = fileName.split('/').filter((s) => s.trim() !== '');
			const leaf = safeFileBase(segs.pop() ?? fileName);
			target = [...segs.map(safeFolderSegment), `${leaf}.md`].join('/');
		}
		target = uniqueTarget(used, target);

		// Every way the page can be named resolves to it: file-derived name, title::, aliases, ISO date.
		for (const key of [fileName, name]) if (!pageIndex.has(indexKey(key))) pageIndex.set(indexKey(key), target);
		for (const [k, v] of props) {
			if (k !== 'alias') continue;
			for (const a of splitList(v)) if (!pageIndex.has(indexKey(a))) pageIndex.set(indexKey(a), target);
		}
		if (iso) pageIndex.set(indexKey(base), target);

		// Block ids: the bullet line directly above `id:: <uuid>` is the block's text.
		let lastText = '';
		for (let i = next; i < lines.length; i++) {
			const idm = idLine.exec(lines[i]);
			if (idm) {
				blocks.set(idm[1].toLowerCase(), { page: name, target, text: lastText });
				continue;
			}
			const b = BULLET.exec(lines[i]);
			if (b && !PROP_LINE.test(b[2])) lastText = cleanBlockText(b[2]).slice(0, 300);
		}

		const extra: LogseqExtra = { name, journal, props, bodyStart: next };
		entries.push({ rel: f.rel, target, size: f.size, extra });
	}

	const warnings: ImportWarning[] = orgSkipped > 0 ? [{ code: 'orgSkipped', count: orgSkipped }] : [];
	const state: LogseqState = { pageIndex, blocks, attachmentRels, legacyNames };
	return makePlan({ adapter: 'logseq', attachments, skipped, warnings, entries, state });
}

async function transform(entry: PlanEntry, ctx: TransformCtx): Promise<TransformResult> {
	const state = ctx.plan.state as LogseqState;
	const extra = entry.extra as LogseqExtra;
	const finalRel = withPrefix(ctx.prefix, entry.target);
	const copied: string[] = [];
	const tags = new Set<string>();
	let unresolvedRefs = 0;

	const lines = ctx.raw.replace(/\r\n?/g, '\n').split('\n').slice(extra.bodyStart);

	// 1. Line level: drop Logseq-only metadata lines, map task markers. Fenced code is left alone.
	const idOnly = new RegExp(`^\\s*id::\\s*${UUID}\\s*$`);
	const out: string[] = [];
	let fence = false;
	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) {
			fence = !fence;
			out.push(line);
			continue;
		}
		if (fence) {
			out.push(line);
			continue;
		}
		if (idOnly.test(line)) continue;
		if (/^\s*(collapsed|heading)::\s*\S*\s*$/.test(line) || /^\s*logseq\.[\w.-]+::/.test(line)) continue;
		const b = BULLET.exec(line);
		if (b) {
			const [, indent, content] = b;
			if (TASK_DONE.test(content)) out.push(`${indent}- [x] ${content.replace(TASK_DONE, '')}`);
			else if (TASK_CANCELED.test(content)) out.push(`${indent}- [x] ~~${content.replace(TASK_CANCELED, '')}~~`);
			else if (TASK_OPEN.test(content)) out.push(`${indent}- [ ] ${content.replace(TASK_OPEN, '')}`);
			else out.push(line);
			continue;
		}
		out.push(line);
	}
	let body = out.join('\n').replace(/^\s+/, '');

	const pageLink = (key: string): string | undefined => {
		const t = state.pageIndex.get(indexKey(key.trim()));
		return t ? withPrefix(ctx.prefix, t) : undefined;
	};

	// 2. Inline level (outside code): block refs/embeds, then tags, then page links.
	const refText = (uuid: string): string => {
		const info = state.blocks.get(uuid.toLowerCase());
		if (!info || !info.text) {
			unresolvedRefs++;
			return '(ref)';
		}
		return info.target === entry.target
			? info.text
			: `${info.text} ([${info.page}](${relativeLink(finalRel, withPrefix(ctx.prefix, info.target))}))`;
	};
	const embedBlockStart = new RegExp(
		`(^|\\n)([ \\t]*(?:-[ \\t]+(?:\\[[ x]\\][ \\t]+)?)?)\\{\\{embed \\(\\((${UUID})\\)\\)\\}\\}`,
		'g'
	);
	const embedBlockInline = new RegExp(`\\{\\{embed \\(\\((${UUID})\\)\\)\\}\\}`, 'g');
	const blockRef = new RegExp(`\\(\\((${UUID})\\)\\)`, 'g');
	body = mapOutsideCode(body, (text) => {
		let s = text;
		// {{embed ((uuid))}} opening a list item or paragraph becomes a blockquote; elsewhere inline quoted text.
		s = s.replace(embedBlockStart, (_m, nl: string, lead: string, uuid: string) => `${nl}${lead}> ${refText(uuid)}`);
		s = s.replace(embedBlockInline, (_m, uuid: string) => `“${refText(uuid)}”`);
		s = s.replace(/\{\{embed \[\[([^\]]+)\]\]\}\}/g, (_m, name: string) => {
			const t = pageLink(name);
			return t ? `[${name}](${relativeLink(finalRel, t)})` : name;
		});
		s = s.replace(blockRef, (_m, uuid: string) => refText(uuid));
		// [label]([[page]]) is Logseq's aliased page link.
		s = s.replace(/\[([^\]]+)\]\(\[\[([^\]]+)\]\]\)/g, (_m, label: string, name: string) => {
			const t = pageLink(name);
			return t ? `[${label}](${relativeLink(finalRel, t)})` : label;
		});
		// #[[multi word]] and #tag in ONE pass: the text an unresolved #[[multi word]] turns into must
		// not be re-scanned as a #multi tag. A #tag is not preceded by a word character, a path/URL/anchor
		// character or another #, and is not all digits (#123).
		s = s.replace(
			/#\[\[([^\]]+)\]\]|(?<![\p{L}\p{N}_&#/\\[(=:])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu,
			(m, multi: string | undefined, tag: string | undefined) => {
				const name = (multi ?? tag ?? '').trim();
				if (multi === undefined && /^\d+$/.test(name)) return m;
				tags.add(name);
				const t = pageLink(name);
				return t ? `[#${name}](${relativeLink(finalRel, t)})` : `#${name}`;
			}
		);
		// Image size attributes: ![x](../assets/a.png){:height 200, :width 300}
		s = s.replace(/(!\[[^\]]*\]\([^)]*\))\{:[^}]*\}/g, '$1');
		return s;
	});
	body = rewriteWikilinksWith(body, finalRel, pageLink);

	// 3. Assets: ../assets/x.png (relative to pages/ or journals/) -> the library's shared attachment copy.
	body = rewriteMarkdownLinks(body, finalRel, (url) => {
		const candidates = [
			resolveSourceLink(entry.rel, url),
			resolveSourceLink('x.md', url.replace(/^(\.\.\/)+/, ''))
		].filter((c): c is string => !!c);
		const hit = candidates.find((c) => state.attachmentRels.has(c));
		if (!hit) return undefined;
		const lib = ctx.copyAttachment(hit, path.posix.basename(hit));
		if (!lib) return undefined;
		copied.push(lib);
		return lib;
	});

	// 4. Frontmatter from page properties.
	const data: Record<string, unknown> = {};
	for (const [k, v] of extra.props) {
		if (k === 'title' || k === 'id') continue;
		if (k === 'alias') data.aliases = splitList(v);
		else if (k === 'tags') for (const t of splitList(v)) tags.add(t);
		else if (v !== '') data[k] = v;
	}
	if (tags.size > 0) data.tags = [...tags];
	// The page name is a reliable title (it is how Logseq itself names the page), so a missing title::
	// does not by itself make the note need review.
	data.title = extra.props.find(([k]) => k === 'title')?.[1] || extra.name;

	const { frontmatter, needsReview } = normalizeFrontmatter(data, {
		sourceRel: entry.rel,
		titleFallback: extra.name,
		convertedBy: 'logseq-import',
		domainDefault: extra.journal ? JOURNAL_FOLDER : undefined
	});
	if (unresolvedRefs > 0) frontmatter.unresolved_block_refs = unresolvedRefs;
	return { relPath: finalRel, markdown: stringifyNote(body, frontmatter), needsReview, attachments: copied };
}

export const logseqAdapter: SourceAdapter = { id: 'logseq', detect, plan, transform };
