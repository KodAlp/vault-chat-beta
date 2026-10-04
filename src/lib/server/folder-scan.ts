import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './app-error';
import {
	skipReasonFor,
	isJunkName,
	extOf,
	MAX_SCAN_DEPTH,
	MAX_SCAN_ENTRIES,
	type SkipReason
} from '../import-filter';

/**
 * Server-side folder scan for the Linux desktop app, where the webview cannot
 * pick a folder (WebKitGTK file chooser is always "open file"). The Tauri
 * dialog hands the dialog an absolute path; the server walks it and later
 * reads individual files out of it. Everything here assumes the path is
 * hostile until proven otherwise.
 *
 * Symlinks are never followed and never listed (a link planted in the tree,
 * e.g. from an extracted untrusted archive, must not pull in files from
 * outside the picked folder). Same posture as importObsidian.ts walkAll.
 */

export interface ScanEntry {
	/** Relative to the picked root, always with / separators. */
	relPath: string;
	size: number;
	skip?: SkipReason;
}

export interface ScanResult {
	/** realpath of the picked root; relPaths are resolved against this. */
	root: string;
	folderName: string;
	entries: ScanEntry[];
}

// Containment checks compare paths, so case must not be a way around them:
// Windows and macOS (APFS default) are case-insensitive, and the JS
// fs.realpathSync does not canonicalize letter case there ("/users/x" vs
// "/Users/x"). Two layers: every realpath below uses realpathSync.native, which
// returns the on-disk canonical case (and expands 8.3 short names on Windows),
// and fold() lowercases on win32 and darwin as belt and braces. Linux stays
// case-sensitive.
function fold(p: string): string {
	return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
}

/** True when `child` is `parent` itself or lies below it. */
export function isInsideDir(child: string, parent: string): boolean {
	const c = fold(child);
	const p = fold(parent);
	return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function realOrNull(p: string): string | null {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return null;
	}
}

function realProtected(protectedDirs: string[]): string[] {
	const out: string[] = [];
	for (const d of protectedDirs) {
		out.push(path.resolve(d));
		const r = realOrNull(d);
		if (r) out.push(r);
	}
	return out;
}

/**
 * Validates a client-supplied folder path and returns its realpath. Throws
 * SCAN_ROOT_INVALID for anything that is not an absolute, existing directory,
 * the filesystem root, or the app's own data / vault directories (or inside
 * them): scanning those could import secrets (providers.json) or the library
 * into itself.
 */
export function validateScanRoot(root: unknown, protectedDirs: string[]): string {
	if (typeof root !== 'string' || root.length === 0 || root.length > 4096 || root.includes('\0')) {
		throw new AppError('SCAN_ROOT_INVALID');
	}
	if (!path.isAbsolute(root)) throw new AppError('SCAN_ROOT_INVALID');
	let real: string;
	try {
		real = fs.realpathSync.native(root);
		if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
	} catch {
		throw new AppError('SCAN_ROOT_INVALID');
	}
	if (path.parse(real).root === real) throw new AppError('SCAN_ROOT_INVALID');
	for (const p of realProtected(protectedDirs)) {
		if (isInsideDir(real, p)) throw new AppError('SCAN_ROOT_INVALID');
	}
	return real;
}

/** Walks a validated root (see validateScanRoot). Bounded in entries and depth. */
export function scanFolder(rootReal: string, protectedDirs: string[] = []): ScanResult {
	const guarded = realProtected(protectedDirs);
	const entries: ScanEntry[] = [];
	const stack: { dir: string; rel: string; depth: number }[] = [{ dir: rootReal, rel: '', depth: 0 }];

	while (stack.length > 0) {
		const { dir, rel, depth } = stack.pop() as { dir: string; rel: string; depth: number };
		let children: fs.Dirent[];
		try {
			children = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue; // unreadable directory: skip it, do not fail the whole scan
		}
		children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const child of children) {
			if (child.isSymbolicLink()) continue;
			const full = path.join(dir, child.name);
			const childRel = rel ? `${rel}/${child.name}` : child.name;
			if (child.isDirectory()) {
				if (isJunkName(child.name) || depth >= MAX_SCAN_DEPTH) continue;
				if (guarded.some((g) => isInsideDir(full, g))) continue;
				stack.push({ dir: full, rel: childRel, depth: depth + 1 });
			} else if (child.isFile()) {
				let size: number;
				try {
					size = fs.lstatSync(full).size;
				} catch {
					continue;
				}
				const skip = skipReasonFor(childRel, size);
				entries.push(skip ? { relPath: childRel, size, skip } : { relPath: childRel, size });
				if (entries.length > MAX_SCAN_ENTRIES) throw new AppError('SCAN_TOO_LARGE', { max: MAX_SCAN_ENTRIES });
			}
		}
	}

	entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
	return { root: rootReal, folderName: path.basename(rootReal), entries };
}

/**
 * Resolves a client-supplied relPath to a file strictly inside the scanned
 * root and re-applies the size / extension rules. `rootReal` must be the
 * realpath stored when the scan ran. Rejects absolute paths, drive letters,
 * ., .. and empty segments, NUL, symlinks, and anything whose realpath
 * leaves the root.
 */
export function resolveScannedFile(rootReal: string, relPath: unknown): { abs: string; size: number } {
	if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 4096 || relPath.includes('\0')) {
		throw new AppError('SCAN_PATH_INVALID');
	}
	if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || /^[\\/]/.test(relPath)) {
		throw new AppError('SCAN_PATH_INVALID');
	}
	const segments = relPath.split(/[\\/]/);
	if (segments.some((s) => s === '' || s === '.' || s === '..')) throw new AppError('SCAN_PATH_INVALID');

	const abs = path.join(rootReal, ...segments);
	let size: number;
	let real: string;
	try {
		const st = fs.lstatSync(abs);
		if (!st.isFile() || st.isSymbolicLink()) throw new Error('not a regular file');
		size = st.size;
		real = fs.realpathSync.native(abs);
	} catch {
		throw new AppError('SCAN_PATH_INVALID');
	}
	if (!isInsideDir(real, rootReal) || fold(real) === fold(rootReal)) throw new AppError('SCAN_PATH_INVALID');

	const reason = skipReasonFor(relPath, size);
	if (reason === 'tooLarge') throw new AppError('FILE_TOO_LARGE', { limitMb: 100 });
	if (reason === 'unsupported') {
		throw new AppError('UNSUPPORTED_FILE_TYPE', { ext: extOf(segments[segments.length - 1]) || '?' });
	}
	if (reason) throw new AppError('SCAN_PATH_INVALID');
	return { abs, size };
}
