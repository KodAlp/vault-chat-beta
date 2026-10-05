import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './app-error';
import { ALLOWED_EXTENSIONS, CODE_EXTENSIONS, MAX_UPLOAD_BYTES, safeBasename } from './library';
import { isInsideDir } from './folder-scan';
import { isInsideAllowedRoots } from './mcp-settings';

/**
 * Validates the local file path an MCP client asked to import. This is the
 * data-exfiltration gate of the whole MCP write surface (an agent that could
 * import any readable file could read ~/.ssh/... into a note and search it),
 * so every check fails closed and the order is deliberate:
 *
 *  1. Empty allowlist -> MCP_IMPORT_ROOTS_EMPTY (local import is simply off).
 *  2. Shape: absolute, no NUL, no `..` segment -> MCP_PATH_INVALID.
 *  3. Containment BEFORE any existence check, so an outside path answers
 *     MCP_PATH_NOT_ALLOWED whether or not the file exists (no oracle for
 *     probing the disk): the realpath of the path must lie inside an allowed
 *     root (realpath resolves ..-tricks and symlinked parent folders); a path
 *     that does not exist is judged by its lexical position instead.
 *  4. Only then: not a symlink itself (lstat), a regular file, an extension
 *     convert.py handles, within the upload size cap -> MCP_PATH_INVALID /
 *     UNSUPPORTED_FILE_TYPE / FILE_TOO_LARGE.
 *  5. Never inside the app's own data/vault folders, even if an allowed root
 *     happens to contain them (providers.json, secrets, other libraries).
 *
 * Returns the realpath to read from. A tiny race remains between this check
 * and the later copy (the file could be swapped for a symlink in between);
 * closing it fully would need fd-based copying and is out of scope — the
 * attacker would already need write access inside a folder the user allowed.
 */
export interface ValidatedImportPath {
	/** realpath of the file — read from this, never from the caller's string. */
	real: string;
	/** Display name (base name only, never a directory). */
	name: string;
	ext: string;
	size: number;
}

export function validateImportPath(
	raw: unknown,
	allowedRoots: string[],
	protectedDirs: string[] = [],
	maxBytes: number = MAX_UPLOAD_BYTES
): ValidatedImportPath {
	if (allowedRoots.length === 0) throw new AppError('MCP_IMPORT_ROOTS_EMPTY', undefined, 403);

	if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096 || raw.includes('\0') || !path.isAbsolute(raw)) {
		throw new AppError('MCP_PATH_INVALID', undefined, 400);
	}
	if (raw.split(/[\\/]+/).includes('..')) throw new AppError('MCP_PATH_INVALID', undefined, 400);

	let real: string;
	try {
		real = fs.realpathSync.native(raw);
	} catch {
		// Missing file: report "not found" only when it would have been inside an allowed root anyway.
		if (isInsideAllowedRoots(path.resolve(raw), allowedRoots)) throw new AppError('MCP_PATH_INVALID', undefined, 404);
		throw new AppError('MCP_PATH_NOT_ALLOWED', undefined, 403);
	}
	if (!isInsideAllowedRoots(real, allowedRoots)) throw new AppError('MCP_PATH_NOT_ALLOWED', undefined, 403);
	for (const dir of protectedDirs) {
		const candidates = [path.resolve(dir)];
		try {
			candidates.push(fs.realpathSync.native(dir));
		} catch {
			// directory does not exist yet — the resolved form above is enough
		}
		if (candidates.some((c) => isInsideDir(real, c))) throw new AppError('MCP_PATH_NOT_ALLOWED', undefined, 403);
	}

	let st: fs.Stats;
	try {
		st = fs.lstatSync(raw);
	} catch {
		throw new AppError('MCP_PATH_INVALID', undefined, 404);
	}
	if (st.isSymbolicLink() || !st.isFile()) throw new AppError('MCP_PATH_INVALID', undefined, 400);

	const name = safeBasename(real);
	const ext = path.extname(name).toLowerCase();
	if (!ALLOWED_EXTENSIONS.has(ext) && !CODE_EXTENSIONS.has(ext)) {
		throw new AppError('UNSUPPORTED_FILE_TYPE', { ext: ext || '?' });
	}
	if (st.size > maxBytes) {
		throw new AppError('FILE_TOO_LARGE', { limitMb: Math.round(maxBytes / (1024 * 1024)) });
	}
	return { real, name, ext, size: st.size };
}
