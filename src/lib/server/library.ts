import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { env } from '$env/dynamic/private';
import { removeLibraryFileFromIndex, renameLibraryFileInIndex } from './incrementalIndex';
import type { LibraryNode, LibrarySettings } from '$lib/types';

const META_DIR = '_meta';
const DEFAULT_SETTINGS: LibrarySettings = { keepOriginals: false };

/**
 * Deliberately does NOT fall back to VAULT_PATH, unlike the indexer's
 * resolveLibraryRoot() (indexer/paths.ts) — this module performs writes
 * (rename, delete, new-file creation from uploads/imports), so it must never
 * default to the user's real Obsidian vault just because VAULT_PATH happens
 * to be set for the (read-only) indexer's backward-compat fallback. Always a
 * new, isolated folder: LIBRARY_PATH if set, else ./data/library.
 */
export function libraryRoot(): string {
	const raw = env.LIBRARY_PATH;
	const root = raw ? path.resolve(process.cwd(), raw) : path.resolve(process.cwd(), 'data', 'library');
	fs.mkdirSync(root, { recursive: true });
	return root;
}

/**
 * Security requirement from the source-ingest skill doc: every fs operation
 * on a user-supplied relative path resolves against the library root and
 * verifies the result is still inside it, before touching disk.
 */
export function resolveLibraryPath(relPath: string): string {
	const root = libraryRoot();
	const resolved = path.resolve(root, relPath);
	const withSep = root.endsWith(path.sep) ? root : root + path.sep;
	if (resolved !== root && !resolved.startsWith(withSep)) {
		throw new Error('Geçersiz yol (library dışına çıkıyor)');
	}
	return resolved;
}

function readNeedsReview(absPath: string): boolean {
	try {
		const raw = fs.readFileSync(absPath, 'utf-8');
		return matter(raw).data.needs_review === true;
	} catch {
		return false;
	}
}

function walkTree(absDir: string, relDir: string): LibraryNode[] {
	const entries = fs
		.readdirSync(absDir, { withFileTypes: true })
		.filter((e) => !e.name.startsWith('.') && e.name !== META_DIR)
		.sort((a, b) => a.name.localeCompare(b.name));

	const nodes: LibraryNode[] = [];
	for (const entry of entries) {
		const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
		const abs = path.join(absDir, entry.name);
		if (entry.isDirectory()) {
			nodes.push({ name: entry.name, path: rel, type: 'folder', children: walkTree(abs, rel) });
		} else if (entry.isFile() && entry.name.endsWith('.md')) {
			nodes.push({
				name: entry.name,
				path: rel,
				type: 'file',
				needsReview: readNeedsReview(abs)
			});
		}
	}
	return nodes;
}

export function getLibraryTree(): LibraryNode[] {
	return walkTree(libraryRoot(), '');
}

/** Files only — renaming a folder would require cascading the index update
 * across every file beneath it; deferred (stated scoping decision, see
 * Faz 5 plan), not silently unsupported: the API route rejects folder
 * targets with a clear error rather than silently doing the fs rename
 * without fixing up the index. */
export function renameLibraryEntry(oldRel: string, newRel: string): void {
	const oldAbs = resolveLibraryPath(oldRel);
	const newAbs = resolveLibraryPath(newRel);
	if (!fs.statSync(oldAbs).isFile()) {
		throw new Error('Sadece dosyalar yeniden adlandırılabilir, klasörler değil');
	}
	fs.mkdirSync(path.dirname(newAbs), { recursive: true });
	fs.renameSync(oldAbs, newAbs);
	renameLibraryFileInIndex(oldRel, newRel);
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

export function deleteLibraryEntry(rel: string): void {
	const abs = resolveLibraryPath(rel);
	const stat = fs.statSync(abs);
	if (stat.isDirectory()) {
		const contained: string[] = [];
		listMarkdownFilesRecursive(abs, rel, contained);
		fs.rmSync(abs, { recursive: true, force: true });
		for (const p of contained) removeLibraryFileFromIndex(p);
	} else {
		fs.unlinkSync(abs);
		removeLibraryFileFromIndex(rel);
	}
}

export function readLibraryFile(rel: string): string {
	return fs.readFileSync(resolveLibraryPath(rel), 'utf-8');
}

export function importLogPath(): string {
	return path.join(libraryRoot(), META_DIR, 'import-log.jsonl');
}

export function stagingDir(): string {
	return path.join(libraryRoot(), META_DIR, 'staging');
}

export function originalsDir(): string {
	return path.join(libraryRoot(), META_DIR, 'originals');
}

export function appendImportLog(entry: object): void {
	const p = importLogPath();
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf-8');
}

/** kebab-case, ascii-folded, collision-safe (numeric suffix) — used to turn
 * a user-edited title into a library filename. */
export function slugify(title: string, domain: string): string {
	const base =
		title
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'adsiz';

	let candidate = base;
	let n = 2;
	while (fs.existsSync(path.join(libraryRoot(), domain, `${candidate}.md`))) {
		candidate = `${base}-${n++}`;
	}
	return candidate;
}

function settingsPath(): string {
	return path.join(libraryRoot(), META_DIR, 'settings.json');
}

/**
 * Server-known at conversion time (unlike theme/model settings, which are
 * plain localStorage) — "keep original PDFs" has to be read by the Python
 * sidecar's caller before it runs, not just by the browser.
 */
export function getLibrarySettings(): LibrarySettings {
	try {
		const raw = fs.readFileSync(settingsPath(), 'utf-8');
		return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<LibrarySettings>) };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveLibrarySettings(settings: LibrarySettings): void {
	const p = settingsPath();
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(settings, null, 2), 'utf-8');
}
