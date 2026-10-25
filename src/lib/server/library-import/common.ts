import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { libraryRoot, importLogPath, appendImportLog } from '../library';
import { resolveLibraryPath } from '../library-read';
import { ATTACHMENT_EXT, attachmentsDir, copyAttachmentIntoLibrary } from '../attachments';
import { indexLibraryFile } from '../incrementalIndex';
import { AppError, toCodedError } from '../app-error';
import { validateScanRoot, isInsideDir } from '../folder-scan';
import { sanitizeDomain } from '../domain-name';
import { MAX_SCAN_DEPTH, MAX_SCAN_ENTRIES, isJunkName } from '../../import-filter';
import { MAX_UPLOAD_BYTES } from '../../import-extensions';
// One shared exclusion list (see the long comment this used to carry in
// importObsidian.ts): a copied-in folder the indexer excludes would be
// indexed on import and silently pruned by the next full reindex.
import { EXCLUDED_DIRS } from '../../../../indexer/excluded-dirs';
import type { ImportResultItem, ImportSummary } from '#lib/types.js';
import type { VaultContext } from '../vaults';
import type {
	ImportPlan,
	SkippedEntry,
	SourceAdapter,
	SourceTree,
	TransformCtx
} from './types';

/*
 * Everything the adapters share. Each rule here exists once on purpose: the
 * adapters only decide WHAT to import and HOW its links/properties map; the
 * walking, the symlink/path safety, the frontmatter defaults, the incremental
 * skip, the write + index + log all live here so a new adapter cannot forget
 * one of them.
 */

/** Wikilink/attachment index key. macOS (HFS+/APFS-via-some-tools) can hand back NFD filenames while the
 * [[links]] typed in a note are NFC, so both sides are NFC-normalized before comparing. */
export function indexKey(name: string): string {
	return name.normalize('NFC').toLowerCase();
}

/** A leading ~ or ~/ (also ~) in a user-typed source path means the home directory. */
export function expandHome(p: string, home: string = os.homedir()): string {
	const t = p.trim();
	if (t === '~') return home;
	if (t.startsWith('~/') || t.startsWith('~\\')) return path.join(home, t.slice(2));
	return p;
}

export function sha256(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

export function isMarkdownName(rel: string): boolean {
	return rel.toLowerCase().endsWith('.md');
}

export function isAttachmentName(rel: string): boolean {
	return ATTACHMENT_EXT.has(path.posix.extname(rel).toLowerCase());
}

// ---------------------------------------------------------------------------
// Root validation + walk
// ---------------------------------------------------------------------------

/**
 * The folder the user typed or picked, validated exactly like the batch
 * folder scan: absolute, an existing directory, not the filesystem root, not
 * inside the app's own data / vault / library dirs (that would import
 * providers.json or the library into itself). A leading ~ is expanded first
 * because the typed-path field invites it. Any failure is the one coded
 * IMPORT_SOURCE_INVALID (the preview shows the same message whatever was wrong).
 */
export function resolveSourceRoot(raw: unknown, protectedDirs: string[]): string {
	const expanded = typeof raw === 'string' ? expandHome(raw) : raw;
	try {
		return validateScanRoot(expanded, protectedDirs);
	} catch (err) {
		if (err instanceof AppError) throw new AppError('IMPORT_SOURCE_INVALID');
		throw err;
	}
}

/**
 * Walks a validated root. Symlinks (file or directory) are never followed or
 * listed: a link planted in the tree, e.g. from a previously extracted
 * untrusted zip, must not pull content from outside the chosen folder into
 * the library. Dot-names and junk are skipped. Indexer-excluded folders
 * (raw/, templates/, node_modules...) are not imported as NOTES, but their
 * attachment files are still listed (except under node_modules): Obsidian
 * vaults very commonly keep their images in an `attachments/` folder, and
 * dropping it made every ![[image.png]] unresolvable. Bounded in depth and
 * in entries (SCAN_TOO_LARGE), like folder-scan.ts.
 */
export function walkSource(rootReal: string): SourceTree {
	const files: SourceTree['files'] = [];
	const tooDeep: string[] = [];
	const stack: { dir: string; rel: string; depth: number; excluded: boolean }[] = [
		{ dir: rootReal, rel: '', depth: 0, excluded: false }
	];
	while (stack.length > 0) {
		const cur = stack.pop() as { dir: string; rel: string; depth: number; excluded: boolean };
		let children: fs.Dirent[];
		try {
			children = fs.readdirSync(cur.dir, { withFileTypes: true });
		} catch {
			continue; // unreadable directory: skip it rather than fail the whole scan
		}
		children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const child of children) {
			if (child.isSymbolicLink() || isJunkName(child.name)) continue;
			const full = path.join(cur.dir, child.name);
			const childRel = cur.rel ? `${cur.rel}/${child.name}` : child.name;
			if (child.isDirectory()) {
				if (child.name === 'node_modules') continue;
				if (cur.depth >= MAX_SCAN_DEPTH) {
					tooDeep.push(childRel);
					continue;
				}
				stack.push({
					dir: full,
					rel: childRel,
					depth: cur.depth + 1,
					excluded: cur.excluded || EXCLUDED_DIRS.has(child.name)
				});
			} else if (child.isFile()) {
				if (cur.excluded && !isAttachmentName(childRel)) continue;
				let size: number;
				try {
					size = fs.lstatSync(full).size;
				} catch {
					continue;
				}
				files.push(cur.excluded ? { rel: childRel, size, fromExcluded: true } : { rel: childRel, size });
				if (files.length > MAX_SCAN_ENTRIES) throw new AppError('SCAN_TOO_LARGE', { max: MAX_SCAN_ENTRIES });
			}
		}
	}
	files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	tooDeep.sort();
	return { root: rootReal, files, tooDeep };
}

export function tooDeepSkips(tree: SourceTree): SkippedEntry[] {
	return tree.tooDeep.map((rel) => ({ rel, reason: 'tooDeep' as const }));
}

/**
 * Resolves a source-relative path to an absolute path strictly inside the
 * scanned root, or null: rejects traversal, symlinks (the file itself, and
 * anything whose realpath leaves the root — a symlinked parent included) and
 * non-regular files. Re-checked on every read, not just at scan time: the
 * folder can change between the preview and the import, and the plan only
 * records WHICH relative paths may be read, never trusted absolute paths.
 */
export function safeSourcePath(rootReal: string, rel: string): { abs: string; size: number } | null {
	if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) return null;
	const segments = rel.split('/');
	if (segments.some((s) => s === '' || s === '.' || s === '..') || /^[a-zA-Z]:/.test(rel)) return null;
	const abs = path.join(rootReal, ...segments);
	try {
		const st = fs.lstatSync(abs);
		if (!st.isFile() || st.isSymbolicLink()) return null;
		const real = fs.realpathSync.native(abs);
		if (!isInsideDir(real, rootReal)) return null;
		return { abs, size: st.size };
	} catch {
		return null;
	}
}

/** UTF-8 text of one source file (BOM stripped) through the safe reader. Throws SCAN_PATH_INVALID / FILE_TOO_LARGE. */
export function readSourceText(rootReal: string, rel: string): string {
	const f = safeSourcePath(rootReal, rel);
	if (!f) throw new AppError('SCAN_PATH_INVALID');
	if (f.size > MAX_UPLOAD_BYTES) throw new AppError('FILE_TOO_LARGE', { limitMb: 100 });
	const text = fs.readFileSync(f.abs, 'utf-8');
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Same as readSourceText but null instead of throwing — detection peeks at files it may not be able to read. */
export function peekSourceText(rootReal: string, rel: string, maxBytes = 8192): string | null {
	const f = safeSourcePath(rootReal, rel);
	if (!f) return null;
	try {
		const fd = fs.openSync(f.abs, 'r');
		try {
			const buf = Buffer.alloc(Math.min(f.size, maxBytes));
			fs.readSync(fd, buf, 0, buf.length, 0);
			return buf.toString('utf-8').replace(/^﻿/, '');
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return null;
	}
}

/** True when `rel` exists below the root as a real (non-symlink) file or directory. */
export function sourceHas(rootReal: string, rel: string): boolean {
	try {
		const st = fs.lstatSync(path.join(rootReal, ...rel.split('/')));
		return !st.isSymbolicLink();
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Names and targets
// ---------------------------------------------------------------------------

const FILE_STRIP = /[<>:"/\\|?*\x00-\x1f\x7f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * One safe file-name base (no extension) on every OS, for adapters that INVENT
 * a name (Logseq page titles, Joplin titles). The markdown-folder adapter
 * keeps its source names untouched, as the Obsidian import always did.
 */
export function safeFileBase(raw: string, maxChars = 100): string {
	let s = String(raw ?? '')
		.normalize('NFC')
		.replace(FILE_STRIP, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^[.\s]+/, '');
	s = Array.from(s).slice(0, maxChars).join('').replace(/[.\s]+$/, '');
	if (!s) return 'untitled';
	if (WINDOWS_RESERVED.test(s.split('.')[0].trimEnd())) s = `${s}_`;
	return s;
}

/** Folder segment of an invented target: sanitizeDomain's rules (also keeps indexer-excluded names out). */
export function safeFolderSegment(raw: string): string {
	return sanitizeDomain(raw);
}

/** Makes `target` unique among `used` (case-insensitive: Windows/macOS) by adding " (2)", " (3)"... before .md. */
export function uniqueTarget(used: Set<string>, target: string): string {
	let candidate = target;
	let n = 2;
	const stem = target.replace(/\.md$/i, '');
	while (used.has(indexKey(candidate))) candidate = `${stem} (${n++}).md`;
	used.add(indexKey(candidate));
	return candidate;
}

export function withPrefix(prefix: string, target: string): string {
	return prefix ? `${prefix}/${target}` : target;
}

/** The user's optional "place under folder" input as one sanitized folder name, '' for none. */
export function normalizePrefix(raw: unknown): string {
	if (typeof raw !== 'string' || raw.trim() === '') return '';
	return sanitizeDomain(raw);
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * Copies one source file into the vault's flat shared attachments folder and
 * returns its library-root-relative path, or null (missing, symlink, over the
 * size limit, or not in ATTACHMENT_EXT). attachments.ts treats the
 * destination NAME as the identity, which is wrong once two different
 * folders each hold an `image.png`: when a file of that name already exists
 * with DIFFERENT content, this one is stored as `<hash8>-<name>` instead of
 * being silently dropped in favour of the other picture.
 */
export function copyAttachmentFromSource(
	v: VaultContext,
	rootReal: string,
	srcRel: string,
	preferredName?: string
): string | null {
	const base = safeFileBase(path.posix.basename(preferredName ?? srcRel), 150);
	// safeFileBase drops nothing of the extension but is meant for bases:
	// re-derive the extension from the real name so '.PNG' etc. survive.
	const ext = path.posix.extname(preferredName ?? srcRel).toLowerCase();
	if (!ATTACHMENT_EXT.has(ext)) return null;
	const f = safeSourcePath(rootReal, srcRel);
	if (!f || f.size > MAX_UPLOAD_BYTES) return null;
	const name = base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
	const dest = path.join(attachmentsDir(v), name);
	let finalName = name;
	if (fs.existsSync(dest)) {
		const mine = crypto.createHash('sha256').update(fs.readFileSync(f.abs)).digest('hex');
		const theirs = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
		if (mine !== theirs) finalName = `${mine.slice(0, 8)}-${name}`;
	}
	return copyAttachmentIntoLibrary(v, f.abs, finalName);
}

// ---------------------------------------------------------------------------
// Link rewriting
// ---------------------------------------------------------------------------

/** Relative, URL-encoded Markdown link destination from one library file to another. */
export function relativeLink(fromRel: string, toRel: string): string {
	const rel = path.posix.relative(path.posix.dirname(fromRel), toRel);
	// encodeURI leaves ( ) # ? alone, and each of them ends a Markdown link
	// destination early (or starts a fragment/query) — a note called "Plan (v2).md".
	return encodeURI(rel).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/#/g, '%23').replace(/\?/g, '%3F');
}

const CODE_SPLIT = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

/** Applies `fn` to the text between code spans/fences only: `[[x]]`, `#tag` or `((id))` inside code is code. */
export function mapOutsideCode(content: string, fn: (text: string) => string): string {
	return content
		.split(CODE_SPLIT)
		.map((part, i) => (i % 2 === 1 ? part : fn(part)))
		.join('');
}

/** Resolves a wikilink target to a library-relative note path, or undefined. */
export type NoteResolver = (target: string) => string | undefined;

/** [[Note]] / [[Note|alias]] / [[Note#heading]] -> relative .md link; unresolved ones degrade to their label. Not
 * applied to the `[[x]]` inside `![[x]]` (an unresolved embed stays visible as written). */
export function rewriteWikilinksWith(content: string, currentRel: string, resolve: NoteResolver): string {
	return mapOutsideCode(content, (text) =>
		text.replace(
			/(?<!!)\[\[([^\]|#]+)(#[^\]|]+)?(\|([^\]]+))?\]\]/g,
			(_m, target: string, _heading: string | undefined, _aliasGroup: string | undefined, alias: string | undefined) => {
				const label = alias ?? target.trim();
				const targetRel = resolve(target.trim());
				if (!targetRel) return label;
				// encodeURI inside relativeLink, not a raw join: an un-encoded space in a markdown link
				// destination ends the link early for most parsers (including this app's), silently
				// degrading the link to literal text.
				return `[${label}](${relativeLink(currentRel, targetRel)})`;
			}
		)
	);
}

/** Backward-compatible form kept for importObsidian.ts's exports and its tests: a basename index (case-insensitive,
 * first match wins — ambiguous duplicate names are an accepted edge case). */
export function rewriteWikilinks(content: string, currentRel: string, mdIndex: Map<string, string>): string {
	return rewriteWikilinksWith(content, currentRel, (target) => mdIndex.get(indexKey(target)));
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

export interface EmbedResolvers {
	/** Source-relative or name -> library-relative attachment path (copying it), or null. */
	attachment(name: string): string | null;
	note: NoteResolver;
}

/** ![[image.png|300]] -> markdown image; ![[doc.pdf]] -> link; ![[Other note]] -> link (transclusion is not reproduced). */
export function rewriteEmbedsWith(content: string, currentRel: string, r: EmbedResolvers): string {
	return mapOutsideCode(content, (text) =>
		text.replace(/!\[\[([^\]]+)\]\]/g, (match, inner: string) => {
			const name = inner.split('|')[0].split('#')[0].trim();
			if (!name) return match;
			const att = r.attachment(name);
			if (att) {
				const link = relativeLink(currentRel, att);
				return IMAGE_EXT.has(path.posix.extname(att).toLowerCase()) ? `![](${link})` : `[${name}](${link})`;
			}
			const note = r.note(name);
			if (note) return `[${name}](${relativeLink(currentRel, note)})`;
			return match;
		})
	);
}

/** null = drop the link but keep its label; undefined = leave untouched; string = library-relative target. */
export type LinkOutcome = string | null | undefined;

const MD_LINK = /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|(?:[^\s()]|\([^\s()]*\))+)((?:\s+(?:"[^"]*"|'[^']*'))?)\s*\)/g;

/**
 * Rewrites standard Markdown links/images whose destination is local. The
 * adapter's `resolve` receives the DECODED destination (no #fragment) and
 * says what it maps to; external URLs, mailto: and pure #anchors never reach
 * it. Used for ../assets/x.png (Logseq), ../_resources/x.png and :/id
 * (Joplin) and relative image links in plain Markdown folders.
 */
export function rewriteMarkdownLinks(
	content: string,
	currentRel: string,
	resolve: (url: string, isImage: boolean) => LinkOutcome
): string {
	return mapOutsideCode(content, (text) =>
		text.replace(MD_LINK, (match, bang: string, label: string, dest: string, title: string) => {
			let url = dest.startsWith('<') ? dest.slice(1, -1) : dest;
			if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#') || url.startsWith('//')) return match;
			const hash = url.indexOf('#');
			const frag = hash === -1 ? '' : url.slice(hash);
			url = hash === -1 ? url : url.slice(0, hash);
			let decoded = url;
			try {
				decoded = decodeURIComponent(url);
			} catch {
				// not valid percent-encoding: use as written
			}
			const out = resolve(decoded, bang === '!');
			if (out === undefined) return match;
			if (out === null) return label;
			return `${bang}[${label}](${relativeLink(currentRel, out)}${frag}${title ?? ''})`;
		})
	);
}

/** Source-root-relative normalized path of a link written relative to a source note, or null when it leaves the root. */
export function resolveSourceLink(noteSourceRel: string, url: string): string | null {
	const joined = url.startsWith('/')
		? url.replace(/^\/+/, '')
		: path.posix.join(path.posix.dirname(noteSourceRel), url);
	const norm = path.posix.normalize(joined);
	if (norm === '..' || norm.startsWith('../') || norm === '.' || path.posix.isAbsolute(norm)) return null;
	return norm;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

function firstString(v: unknown): string | undefined {
	if (typeof v === 'string' && v.trim()) return v;
	if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0];
	return undefined;
}

/**
 * The library's frontmatter contract (title / domain / level) on top of
 * whatever the source note already had. Anything missing is defaulted and the
 * note is flagged needs_review so the user sees it in the tree. `domainDefault`
 * lets an adapter supply a meaningful domain (Logseq journals, a Joplin
 * notebook) which then does NOT count as a missing field.
 */
export function normalizeFrontmatter(
	data: Record<string, unknown>,
	opts: { sourceRel: string; titleFallback: string; convertedBy: string; domainDefault?: string; now?: Date }
): { frontmatter: Record<string, unknown>; needsReview: boolean } {
	const titleGiven = firstString(data.title) ?? firstString(data.topic);
	const domainGiven = firstString(data.domain) ?? firstString(data.domains);
	const levelGiven = firstString(data.level) ?? firstString(data.depth);
	const domainFallback = opts.domainDefault ?? 'genel';
	const needsReview = !titleGiven || (!domainGiven && opts.domainDefault === undefined) || !levelGiven;
	const frontmatter: Record<string, unknown> = {
		...data,
		title: titleGiven ?? opts.titleFallback,
		domain: domainGiven ?? domainFallback,
		level: levelGiven ?? 'undergraduate',
		source_file: opts.sourceRel,
		converted_by: opts.convertedBy,
		converted_at: (opts.now ?? new Date()).toISOString().slice(0, 10),
		...(needsReview ? { needs_review: true } : {})
	};
	return { frontmatter, needsReview };
}

/**
 * Library notes are always written with LF. gray-matter emits the frontmatter
 * with LF but keeps the body's own line endings, so a CRLF source (any file
 * saved on Windows) would otherwise come out with mixed line endings.
 */
export function stringifyNote(body: string, frontmatter: Record<string, unknown>): string {
	return matter.stringify(body.replace(/\r\n?/g, '\n'), frontmatter);
}

// ---------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------

export function makePlan(
	base: Pick<ImportPlan, 'adapter' | 'flavor' | 'attachments' | 'skipped' | 'warnings' | 'entries' | 'state'>
): ImportPlan {
	return { ...base, notes: base.entries.length, sampleTargets: base.entries.slice(0, 10).map((e) => e.target) };
}

// ---------------------------------------------------------------------------
// Import log (incremental skip)
// ---------------------------------------------------------------------------

interface LogEntry {
	sourcePath: string;
	sha256: string;
	importedAt: string;
	status: string;
	adapter?: string;
}

export function loadLastKnownHashes(logPath: string): Map<string, string> {
	const known = new Map<string, string>();
	if (!fs.existsSync(logPath)) return known;
	const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as LogEntry;
			if (entry.sourcePath) known.set(entry.sourcePath, entry.sha256);
		} catch {
			// malformed line — skip, don't let one bad entry break the whole scan
		}
	}
	return known;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type Indexer = (v: VaultContext, absPath: string, relPath: string) => Promise<void>;

/**
 * Writes one converted note into the library. The target comes from adapter
 * code and from file names in a folder the user does not control, so it gets
 * the same gate as every other library write: resolveLibraryPath containment,
 * no traversal, never into _meta, never through a symlinked directory or onto
 * a symlinked file.
 */
export function writeLibraryNote(v: VaultContext, relPath: string, markdown: string): string {
	const segments = relPath.split('/');
	if (
		relPath.length === 0 ||
		relPath.includes('\0') ||
		path.isAbsolute(relPath) ||
		/^[a-zA-Z]:/.test(relPath) ||
		segments.some((s) => s === '' || s === '.' || s === '..') ||
		segments[0].toLowerCase() === '_meta' ||
		!isMarkdownName(relPath)
	) {
		throw new AppError('PATH_OUTSIDE_LIBRARY');
	}
	let destAbs: string;
	try {
		destAbs = resolveLibraryPath(v, relPath);
	} catch {
		throw new AppError('PATH_OUTSIDE_LIBRARY');
	}
	const rootAbs = libraryRoot(v);
	fs.mkdirSync(path.dirname(destAbs), { recursive: true });
	const realParent = fs.realpathSync.native(path.dirname(destAbs));
	if (!isInsideDir(realParent, fs.realpathSync.native(rootAbs))) throw new AppError('PATH_OUTSIDE_LIBRARY');
	try {
		if (fs.lstatSync(destAbs).isSymbolicLink()) throw new AppError('PATH_OUTSIDE_LIBRARY');
	} catch (err) {
		if (err instanceof AppError) throw err;
		// ENOENT: the normal case, a new file
	}
	fs.writeFileSync(destAbs, markdown, 'utf-8');
	return destAbs;
}

export interface RunOptions {
	targetPrefix?: string;
	/** Injectable so tests need no embedding backend (same idea as library-write.ts). */
	indexer?: Indexer;
	onProgress?: (item: ImportResultItem) => void;
}

/**
 * Imports exactly the entries recorded in `plan` (never walks the source
 * again): per entry read -> incremental check -> transform -> write -> index
 * -> log. One failing note becomes a failed item, never aborts the rest.
 *
 * Incremental key = the final library path (== the source-relative path for
 * a plain Markdown folder without a prefix, which is what the Obsidian import
 * has always logged, so existing logs keep working) + the sha256 of the SOURCE
 * text. Caveat shared with the old importer: a note whose own text did not
 * change is skipped even if a note it links to was renamed.
 */
export async function runImport(
	v: VaultContext,
	adapter: SourceAdapter,
	plan: ImportPlan,
	rootReal: string,
	opts: RunOptions = {}
): Promise<ImportSummary> {
	const prefix = normalizePrefix(opts.targetPrefix);
	const indexer = opts.indexer ?? indexLibraryFile;
	const logPath = importLogPath(v);
	const lastKnown = loadLastKnownHashes(logPath);
	const items: ImportResultItem[] = [];
	const emit = (item: ImportResultItem) => {
		items.push(item);
		opts.onProgress?.(item);
	};

	for (const entry of plan.entries) {
		const finalRel = withPrefix(prefix, entry.target);
		try {
			const raw = readSourceText(rootReal, entry.rel);
			const hash = sha256(raw);

			if (lastKnown.get(finalRel) === hash && fs.existsSync(resolveLibraryPath(v, finalRel))) {
				emit({ id: crypto.randomUUID(), fileName: entry.rel, status: 'skipped' });
				continue;
			}

			const ctx: TransformCtx = {
				v,
				root: rootReal,
				plan,
				prefix,
				raw,
				copyAttachment: (srcRel, preferredName) => copyAttachmentFromSource(v, rootReal, srcRel, preferredName)
			};
			const out = await adapter.transform(entry, ctx);
			const destAbs = writeLibraryNote(v, out.relPath, out.markdown);
			await indexer(v, destAbs, out.relPath);

			const status = out.needsReview ? 'needs_review' : 'converted';
			appendImportLog(v, {
				sourcePath: out.relPath,
				sha256: hash,
				importedAt: new Date().toISOString(),
				status,
				adapter: adapter.id
			} satisfies LogEntry);
			emit({ id: crypto.randomUUID(), fileName: entry.rel, status, path: out.relPath });
		} catch (err) {
			const coded = toCodedError(err);
			emit({
				id: crypto.randomUUID(),
				fileName: entry.rel,
				status: 'failed',
				code: coded.code,
				params: coded.params,
				reason: coded.code
			});
		}
	}
	return { items };
}

/** Helper for adapters: all entries of `tree` that are Markdown notes outside excluded dirs, with their sizes. */
export function markdownFiles(tree: SourceTree): SourceTree['files'] {
	return tree.files.filter((f) => !f.fromExcluded && isMarkdownName(f.rel));
}
