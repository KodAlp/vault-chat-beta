import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './env';
import { AppError } from './app-error';
import { isInsideDir } from './folder-scan';

/**
 * DATA_DIR/mcp-settings.json — what the USER has allowed MCP clients to do,
 * set in the app's settings page (GET/PUT /api/settings/mcp, a normal
 * session-gated route). Deliberately NOT reachable under /api/mcp/*: the MCP
 * token must never be able to widen its own allowlist.
 *
 * Today that is one list: folders an MCP client may import local files from
 * (`import_source` with a path). Empty by default, which means "no local file
 * import at all" — the safe state for a data-exfiltration channel (an agent
 * that could import ~/.ssh/... into a note and then search it).
 */
export interface McpSettings {
	allowedImportRoots: string[];
}

export const MAX_ALLOWED_IMPORT_ROOTS = 20;
const FILE_NAME = 'mcp-settings.json';

function filePath(): string {
	return path.join(dataDir(), FILE_NAME);
}

function samePath(a: string, b: string): boolean {
	return isInsideDir(a, b) && isInsideDir(b, a);
}

/**
 * Validates a PUT body's list: every entry must be an absolute path to an
 * existing directory (never the filesystem root — that would allow
 * everything), is stored as its realpath (symlinks and 8.3/short names
 * resolved, on-disk letter case), deduplicated, at most
 * MAX_ALLOWED_IMPORT_ROOTS. Throws a coded 400 instead of silently dropping
 * entries: a user who typed a bad folder should be told, not left wondering
 * why imports from it fail.
 */
export function sanitizeImportRoots(raw: unknown): string[] {
	if (!Array.isArray(raw)) throw new AppError('VALIDATION_INVALID', { field: 'allowedImportRoots' });
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'string' || entry.length === 0 || entry.length > 4096 || entry.includes('\0') || !path.isAbsolute(entry)) {
			throw new AppError('VALIDATION_INVALID', { field: 'allowedImportRoots' });
		}
		let real: string;
		try {
			real = fs.realpathSync.native(entry);
			if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
		} catch {
			throw new AppError('VALIDATION_INVALID', { field: 'allowedImportRoots' });
		}
		if (path.parse(real).root === real) throw new AppError('VALIDATION_INVALID', { field: 'allowedImportRoots' });
		if (!out.some((existing) => samePath(existing, real))) out.push(real);
		if (out.length > MAX_ALLOWED_IMPORT_ROOTS) {
			throw new AppError('VALIDATION_INVALID', { field: 'allowedImportRoots', max: MAX_ALLOWED_IMPORT_ROOTS });
		}
	}
	return out;
}

/** Missing or corrupt file reads as the default (no roots). Entries are not
 * re-validated here (a folder may have moved since it was saved); the import
 * check re-resolves each root and simply skips the ones that no longer exist. */
export function readMcpSettings(): McpSettings {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf-8')) as { allowedImportRoots?: unknown };
		const roots = Array.isArray(parsed.allowedImportRoots)
			? parsed.allowedImportRoots.filter((r): r is string => typeof r === 'string' && path.isAbsolute(r))
			: [];
		return { allowedImportRoots: roots.slice(0, MAX_ALLOWED_IMPORT_ROOTS) };
	} catch {
		return { allowedImportRoots: [] };
	}
}

/** Replaces the whole list (the settings page always sends the full list).
 * Atomic write, same as ui-prefs-store.ts. */
export function writeMcpSettings(patch: { allowedImportRoots?: unknown }): McpSettings {
	const next: McpSettings = {
		allowedImportRoots:
			patch.allowedImportRoots === undefined ? readMcpSettings().allowedImportRoots : sanitizeImportRoots(patch.allowedImportRoots)
	};
	const p = filePath();
	const tmp = `${p}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
	fs.renameSync(tmp, p);
	return next;
}

/**
 * True when `realFile` (already a realpath) lies inside one of the allowed
 * roots. Each root is re-resolved with realpath first, so a root that was
 * replaced by a symlink after being saved cannot widen access. Comparison is
 * case-insensitive on Windows/macOS and respects path-segment boundaries
 * (`C:\a\b` is not inside `C:\a\bc`) — both via folder-scan.ts's isInsideDir.
 */
export function isInsideAllowedRoots(realFile: string, roots: string[]): boolean {
	for (const root of roots) {
		let realRoot: string;
		try {
			realRoot = fs.realpathSync.native(root);
		} catch {
			continue;
		}
		if (path.parse(realRoot).root === realRoot) continue;
		if (isInsideDir(realFile, realRoot)) return true;
	}
	return false;
}
