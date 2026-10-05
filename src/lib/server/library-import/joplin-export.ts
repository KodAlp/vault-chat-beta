import path from 'node:path';
import matter from 'gray-matter';
import {
	indexKey,
	isAttachmentName,
	isMarkdownName,
	makePlan,
	normalizeFrontmatter,
	peekSourceText,
	relativeLink,
	resolveSourceLink,
	rewriteMarkdownLinks,
	safeFileBase,
	safeFolderSegment,
	stringifyNote,
	tooDeepSkips,
	uniqueTarget,
	walkSource,
	withPrefix
} from './common';
import { MAX_UPLOAD_BYTES } from '../../import-extensions';
import type { DetectResult, ImportPlan, ImportWarning, PlanEntry, SkippedEntry, SourceAdapter, SourceTree, TransformCtx, TransformResult } from './types';

/**
 * Joplin "File > Export all > MD - Markdown + Front Matter" folder -> library notes.
 *
 * ASSUMPTIONS (written from memory of Joplin's exporter, not verified against
 * a current release — this adapter is deliberately defensive about each one):
 *  - Notebooks are folders (nested notebooks = nested folders), notes are
 *    `<title>.md` files inside them, each starting with a YAML frontmatter block
 *    with at least `title`, and usually `updated`, `created`, `latitude`,
 *    `longitude`, `altitude`, `author`, `source_url`, `is_todo`, `tags`. The
 *    note id is NOT guaranteed to be in the frontmatter; when a note has an
 *    `id` it is used to resolve `:/<id>` note links, otherwise those links lose
 *    their link and keep their text.
 *  - Attachments live in a `_resources/` folder at the export root (or, in
 *    some versions, next to the notes: any folder named `_resources` is
 *    treated as one). Resource files are named after the resource id (32 hex
 *    characters) plus the extension, so a `:/<id>` link is matched by the id
 *    prefix of the file name.
 *  - Links are either relative (`../_resources/abc.png`, `Other%20note.md`) or
 *    Joplin-internal `:/<32 hex>` ids (images and notes). Both are rewritten
 *    to library-relative links; HTML <img src=":/id"> (resized images) becomes
 *    a Markdown image.
 *  - Resource types outside the library's attachment allowlist (zip, docx,
 *    audio...) are not copied and are listed as skipped; links to them keep
 *    their text.
 */

const RESOURCES_DIR = '_resources';
const ID_PREFIX = /^([0-9a-f]{32})/i;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function inResources(rel: string): boolean {
	return rel.split('/').slice(0, -1).includes(RESOURCES_DIR);
}

function frontmatterOf(text: string | null): Record<string, unknown> | null {
	if (!text) return null;
	const m = FRONTMATTER.exec(text);
	if (!m) return null;
	try {
		return matter(`---\n${m[1]}\n---\n`).data as Record<string, unknown>;
	} catch {
		return null;
	}
}

function looksLikeJoplin(fm: Record<string, unknown> | null): { basic: boolean; specific: boolean } {
	if (!fm) return { basic: false, specific: false };
	const basic = 'title' in fm && ('created' in fm || 'updated' in fm);
	// Keys only Joplin's exporter writes, which an ordinary Zettelkasten frontmatter would not.
	const specific = ['latitude', 'longitude', 'altitude', 'is_todo', 'markup_language'].some((k) => k in fm);
	return { basic, specific };
}

function toTags(v: unknown): string[] {
	const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
	return list.map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean);
}

function nonEmptyString(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

interface JoplinState extends Record<string, unknown> {
	/** 32-hex resource id -> source rel of the resource file. */
	resourceById: Map<string, string>;
	/** source rel of every attachment-type resource. */
	resourceRels: Set<string>;
	/** note source rel -> target rel (no prefix). */
	targetByRel: Map<string, string>;
	/** indexKey(note basename without .md) -> target rel, only for names that are unique. */
	targetByName: Map<string, string>;
	/** frontmatter id -> target rel. */
	targetById: Map<string, string>;
}

async function detect(root: string, tree: SourceTree = walkSource(root)): Promise<DetectResult> {
	const warnings: ImportWarning[] = [];
	const hasResources = tree.files.some((f) => inResources(f.rel));
	const sample = tree.files.filter((f) => !f.fromExcluded && isMarkdownName(f.rel) && !inResources(f.rel)).slice(0, 20);
	let basic = 0;
	let specific = 0;
	for (const f of sample) {
		const r = looksLikeJoplin(frontmatterOf(peekSourceText(root, f.rel, 4096)));
		if (r.basic) basic++;
		if (r.specific) specific++;
	}
	if (hasResources && basic > 0) return { match: true, confidence: 0.9, warnings };
	// An export without any attachment has no _resources/; trust it only with a Joplin-only key.
	if (specific > 0 && basic > 0) return { match: true, confidence: 0.6, warnings };
	return { match: false, confidence: 0, warnings };
}

async function plan(root: string, tree: SourceTree = walkSource(root)): Promise<ImportPlan> {
	const entries: PlanEntry[] = [];
	const skipped: SkippedEntry[] = tooDeepSkips(tree);
	const resourceById = new Map<string, string>();
	const resourceRels = new Set<string>();
	const targetByRel = new Map<string, string>();
	const nameCount = new Map<string, number>();
	const nameTarget = new Map<string, string>();
	const targetById = new Map<string, string>();
	const used = new Set<string>();
	let attachments = 0;
	let noIds = 0;

	for (const f of tree.files) {
		if (inResources(f.rel)) {
			if (isAttachmentName(f.rel)) {
				attachments++;
				resourceRels.add(f.rel);
				const m = ID_PREFIX.exec(path.posix.basename(f.rel));
				if (m) resourceById.set(m[1].toLowerCase(), f.rel);
			} else skipped.push({ rel: f.rel, reason: 'unsupported' });
			continue;
		}
		if (f.fromExcluded) continue;
		if (!isMarkdownName(f.rel)) {
			skipped.push({ rel: f.rel, reason: 'unsupported' });
			continue;
		}
		if (f.size > MAX_UPLOAD_BYTES) {
			skipped.push({ rel: f.rel, reason: 'tooLarge' });
			continue;
		}
		const segs = f.rel.split('/');
		const leaf = safeFileBase(segs.pop()!.replace(/\.md$/i, ''));
		const target = uniqueTarget(used, [...segs.map(safeFolderSegment), `${leaf}.md`].join('/'));
		entries.push({ rel: f.rel, target, size: f.size });
		targetByRel.set(f.rel, target);

		const key = indexKey(path.posix.basename(f.rel, path.posix.extname(f.rel)));
		nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
		nameTarget.set(key, target);

		const id = nonEmptyString(frontmatterOf(peekSourceText(root, f.rel, 4096))?.id);
		if (id) targetById.set(id.toLowerCase(), target);
		else noIds++;
	}

	const targetByName = new Map<string, string>();
	for (const [k, n] of nameCount) if (n === 1) targetByName.set(k, nameTarget.get(k)!);

	const warnings: ImportWarning[] = noIds > 0 && entries.length > 0 ? [{ code: 'joplinNoIds', count: noIds }] : [];
	const state: JoplinState = { resourceById, resourceRels, targetByRel, targetByName, targetById };
	return makePlan({ adapter: 'joplin-export', attachments, skipped, warnings, entries, state });
}

async function transform(entry: PlanEntry, ctx: TransformCtx): Promise<TransformResult> {
	const state = ctx.plan.state as JoplinState;
	const finalRel = withPrefix(ctx.prefix, entry.target);
	const copied: string[] = [];

	const parsed = matter(ctx.raw);
	const fm = parsed.data as Record<string, unknown>;

	const attach = (srcRel: string): string | null => {
		const lib = ctx.copyAttachment(srcRel, path.posix.basename(srcRel));
		if (lib) copied.push(lib);
		return lib;
	};

	// One resolver for both Markdown links and HTML <img>: :/id first, then relative paths.
	const resolve = (url: string): string | null | undefined => {
		const idm = /^:\/([0-9a-f]{32})/i.exec(url);
		if (idm) {
			const id = idm[1].toLowerCase();
			const res = state.resourceById.get(id);
			if (res) return attach(res) ?? null;
			const note = state.targetById.get(id);
			if (note) return withPrefix(ctx.prefix, note);
			return null; // an id nothing here has: drop the dead link, keep its text
		}
		const src = resolveSourceLink(entry.rel, url);
		if (!src) return undefined;
		if (state.resourceRels.has(src)) return attach(src) ?? undefined;
		const byPath = state.targetByRel.get(src);
		if (byPath) return withPrefix(ctx.prefix, byPath);
		if (isMarkdownName(src)) {
			const byName = state.targetByName.get(indexKey(path.posix.basename(src, path.posix.extname(src))));
			if (byName) return withPrefix(ctx.prefix, byName);
		}
		return undefined;
	};

	let body = parsed.content.replace(/<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi, (match, src: string) => {
		const out = resolve(src);
		if (!out) return match;
		const alt = /\balt=["']([^"']*)["']/i.exec(match)?.[1] ?? '';
		return `![${alt}](${relativeLink(finalRel, out)})`;
	});
	body = rewriteMarkdownLinks(body, finalRel, (url) => resolve(url));

	const base = path.posix.basename(entry.rel, path.posix.extname(entry.rel));
	const title = nonEmptyString(fm.title) ?? base;
	const data: Record<string, unknown> = { title };
	const tags = toTags(fm.tags);
	if (tags.length > 0) data.tags = tags;
	if (fm.created) data.created = fm.created;
	if (fm.updated) data.updated = fm.updated;
	const source = nonEmptyString(fm.source_url) ?? nonEmptyString(fm.source);
	if (source) data.source_url = source;
	const author = nonEmptyString(fm.author);
	if (author) data.author = author;

	// The top-level notebook is a natural domain; notes at the export root have none.
	const segs = entry.rel.split('/');
	const { frontmatter, needsReview } = normalizeFrontmatter(data, {
		sourceRel: entry.rel,
		titleFallback: title,
		convertedBy: 'joplin-import',
		domainDefault: segs.length > 1 ? safeFolderSegment(segs[0]) : undefined
	});
	return { relPath: finalRel, markdown: stringifyNote(body, frontmatter), needsReview, attachments: copied };
}

export const joplinExportAdapter: SourceAdapter = { id: 'joplin-export', detect, plan, transform };
