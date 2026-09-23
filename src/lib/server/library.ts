import fs from 'node:fs';
import path from 'node:path';
import { removeLibraryFileFromIndex, renameLibraryFileInIndex } from './incrementalIndex';
import { foldToSlug } from './slug';
import { resolveLibraryPath, settingsPath } from './library-read';
import type { LibrarySettings } from '$lib/types';
import type { VaultContext } from './vaults';

const META_DIR = '_meta';

/** Same set convert.py actually routes on (MARKITDOWN_EXTS + PDF_EXT +
 * TEX_EXT) plus .md for a source that's already Markdown — anything else is
 * something the converter would only ever fail on or mis-handle, so it's
 * rejected before a subprocess (and its memory/CPU cost) is spent on it.
 * Shared by both /api/import and /api/import/batch — a single copy so the
 * two routes can't drift out of sync with each other again. */
export const ALLOWED_EXTENSIONS = new Set([
	'.pdf',
	'.docx',
	'.pptx',
	'.xlsx',
	'.html',
	'.htm',
	'.epub',
	'.tex',
	'.md'
]);

/** Generous enough for a large scanned PDF, small enough that one request
 * can't buffer an unbounded upload into memory — see the size check at each
 * call site, which runs BEFORE arrayBuffer() is called, not after. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** A browser's <input type=file> always sends a bare filename, but nothing
 * enforces that at the HTTP layer — a hand-crafted multipart request (curl,
 * a script) can set filename="..\\..\\evil.md" and reach a path outside the
 * intended directory wherever that raw name is later joined onto one (the
 * originals copy, `--source-name`'s source_file frontmatter). Moved here
 * (2026-09-23) from a private copy in api/import/+server.ts, which was the
 * only one of the two upload routes that had it — /api/import/batch used
 * `file.name` raw. */
export function safeBasename(name: string): string {
	// path.basename alone doesn't strip a Windows-style "..\\" prefix on
	// POSIX (no backslash-as-separator there), so both separators are
	// normalized to "/" first.
	return path.basename(name.replace(/\\/g, '/'));
}

// Read-only tree/file-read/settings-read functions moved to library-read.ts
// (a leaf module with no incrementalIndex/./ollama dependency — see its own
// doc comment and the mcp-server skill for why). Re-exported here so every
// existing call site (`$lib/server/library`) keeps working unchanged.
export { resolveLibraryPath, getLibraryTree, readLibraryFile, getLibrarySettings } from './library-read';

/**
 * Ensures the vault's library root exists and returns it. The vault is
 * created with this folder already present (vaults.ts createVault()), but
 * every write path here re-asserts it defensively — matches the original
 * single-vault libraryRoot()'s mkdirSync-on-every-call behavior.
 *
 * Writer-side only — library-read.ts's resolveLibraryPath() deliberately
 * does NOT call this (no mkdirSync from a read path).
 */
export function libraryRoot(v: VaultContext): string {
	fs.mkdirSync(v.libraryRoot, { recursive: true });
	return v.libraryRoot;
}

/** Files only — renaming a folder would require cascading the index update
 * across every file beneath it; deferred (stated scoping decision, see
 * Faz 5 plan), not silently unsupported: the API route rejects folder
 * targets with a clear error rather than silently doing the fs rename
 * without fixing up the index. */
export function renameLibraryEntry(v: VaultContext, oldRel: string, newRel: string): void {
	const oldAbs = resolveLibraryPath(v, oldRel);
	const newAbs = resolveLibraryPath(v, newRel);
	if (!fs.statSync(oldAbs).isFile()) {
		throw new Error('Sadece dosyalar yeniden adlandırılabilir, klasörler değil');
	}
	// Windows' renameSync refuses to overwrite an existing target (EPERM/
	// EEXIST) — check explicitly so the route can return a translated
	// message instead of a raw fs error string.
	if (fs.existsSync(newAbs)) {
		throw new Error('Bu isimde bir dosya zaten var');
	}
	fs.mkdirSync(path.dirname(newAbs), { recursive: true });
	fs.renameSync(oldAbs, newAbs);
	renameLibraryFileInIndex(v, oldRel, newRel);
}

function listMarkdownFilesRecursive(absDir: string, relDir: string, out: string[]): void {
	for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
		const abs = path.join(absDir, entry.name);
		if (entry.isDirectory()) listMarkdownFilesRecursive(abs, rel, out);
		else if (entry.isFile() && entry.name.endsWith('.md')) out.push(rel);
	}
}

export function deleteLibraryEntry(v: VaultContext, rel: string): void {
	const abs = resolveLibraryPath(v, rel);
	const stat = fs.statSync(abs);
	if (stat.isDirectory()) {
		const contained: string[] = [];
		listMarkdownFilesRecursive(abs, rel, contained);
		fs.rmSync(abs, { recursive: true, force: true });
		for (const p of contained) removeLibraryFileFromIndex(v, p);
	} else {
		fs.unlinkSync(abs);
		removeLibraryFileFromIndex(v, rel);
	}
}

export function importLogPath(v: VaultContext): string {
	return path.join(libraryRoot(v), META_DIR, 'import-log.jsonl');
}

export function stagingDir(v: VaultContext): string {
	return path.join(libraryRoot(v), META_DIR, 'staging');
}

export function originalsDir(v: VaultContext): string {
	return path.join(libraryRoot(v), META_DIR, 'originals');
}

export function appendImportLog(v: VaultContext, entry: object): void {
	const p = importLogPath(v);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Successfully-imported sources by their ORIGINAL file's sha256 (E5) — the
 * same shape as link-import.ts's loadImportedUrls, keyed by content instead
 * of URL, so a re-uploaded copy of a PDF already in the library (renamed,
 * or fetched from a different link) is still recognized as "already have
 * this", not just an exact-URL repeat.
 *
 * `sourceSha256` (the original file's hash, from convert.py's
 * `source_sha256` frontmatter) is a different value from the log entry's
 * own `sha256` field (the hash of the final CURATED Markdown, which
 * changes on every re-title/re-domain edit even when the source didn't).
 */
export function loadImportedSourceHashes(logPath: string): Set<string> {
	const known = new Set<string>();
	if (!fs.existsSync(logPath)) return known;
	const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as { sourceSha256?: string; status?: string };
			if (entry.sourceSha256 && (entry.status === 'converted' || entry.status === 'needs_review')) {
				known.add(entry.sourceSha256);
			}
		} catch {
			// malformed line — skip, don't let one bad entry break the whole scan
		}
	}
	return known;
}

/** kebab-case, ascii-folded, collision-safe (numeric suffix) — used to turn
 * a user-edited title into a library filename. */
export function slugify(v: VaultContext, title: string, domain: string): string {
	const base = foldToSlug(title);

	let candidate = base;
	let n = 2;
	while (fs.existsSync(path.join(libraryRoot(v), domain, `${candidate}.md`))) {
		candidate = `${base}-${n++}`;
	}
	return candidate;
}

export function saveLibrarySettings(v: VaultContext, settings: LibrarySettings): void {
	const p = settingsPath(v);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(settings, null, 2), 'utf-8');
}
