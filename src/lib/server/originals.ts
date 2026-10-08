import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { originalsDir, getLibrarySettings, safeBasename } from './library';
import { logAppEvent } from './app-log';
import type { VaultContext } from './vaults';

/**
 * Kept originals: `_meta/originals/<sha256 first 16>-<safe original name>`.
 *
 * The hash is the sha256 of the ORIGINAL input bytes — the same value
 * ingest/convert.py writes to the note's `source_sha256` frontmatter
 * (sha256_of_file(in_path), the file handed to the converter, not the converted
 * Markdown). A note can therefore be linked back to its original later by
 * hash alone (originalPathForSourceSha), and importing the same bytes twice
 * under different names stores one file.
 *
 * Files written by older versions are named `<importId>-<name>` (a UUID
 * prefix). They are never migrated or deleted; they simply cannot be found by
 * hash, which is the only thing they lacked.
 */

export const ORIGINAL_HASH_PREFIX_LEN = 16;
const MAX_NAME_CHARS = 120;
const SHA_RE = /^[0-9a-f]{16,64}$/;

/** Lower-cased first 16 hex chars of `sha`, or null when it is not a usable hex hash. */
export function shaPrefix(sha: string): string | null {
	const s = sha.trim().toLowerCase();
	return SHA_RE.test(s) ? s.slice(0, ORIGINAL_HASH_PREFIX_LEN) : null;
}

/** `<sha16>-<name>`; the name is reduced to a basename and capped so a long upload name cannot exceed path limits. */
export function originalFileName(sha: string, displayName: string): string | null {
	const prefix = shaPrefix(sha);
	if (!prefix) return null;
	let base = safeBasename(displayName).replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim() || 'original';
	if (base.length > MAX_NAME_CHARS) {
		const ext = path.extname(base).slice(0, 12);
		base = base.slice(0, MAX_NAME_CHARS - ext.length) + ext;
	}
	return `${prefix}-${base}`;
}

/** Pure lookup over a directory listing: the entry kept for `sha`, or null. */
export function findOriginalName(names: readonly string[], sha: string): string | null {
	const prefix = shaPrefix(sha);
	if (!prefix) return null;
	const head = `${prefix}-`;
	return names.find((n) => n.startsWith(head)) ?? null;
}

/**
 * Absolute path of the kept original whose content hash starts like `sha`
 * (typically a note's `source_sha256`), or null when none was kept. The
 * "Yeniden içe aktar" action (api/library/reimport) uses it to find the file to convert again.
 */
export function originalPathForSourceSha(v: VaultContext, sha: string): string | null {
	let names: string[];
	try {
		names = fs.readdirSync(originalsDir(v));
	} catch {
		return null;
	}
	const hit = findOriginalName(names, sha);
	return hit ? path.join(originalsDir(v), hit) : null;
}

function sha256OfFile(abs: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		fs.createReadStream(abs)
			.on('data', (chunk) => hash.update(chunk))
			.on('error', reject)
			.on('end', () => resolve(hash.digest('hex')));
	});
}

/**
 * Keeps a copy of an input file when the vault's keepOriginals setting is on.
 * `knownSha` (full sha256 of the file, if the caller already has it) saves a
 * second read. Dedupes by content: if a file for this hash already exists the
 * copy is skipped. Never throws — an original is a convenience, and losing it
 * must not fail an import that otherwise succeeded. Returns the stored file
 * name (or null when nothing was stored).
 */
export async function keepOriginalCopy(v: VaultContext, srcAbs: string, displayName: string, knownSha?: string): Promise<string | null> {
	try {
		if (!getLibrarySettings(v).keepOriginals) return null;
		const sha = knownSha && shaPrefix(knownSha) ? knownSha : await sha256OfFile(srcAbs);
		const name = originalFileName(sha, displayName);
		if (!name) return null;
		const existing = originalPathForSourceSha(v, sha);
		if (existing) return path.basename(existing);
		fs.mkdirSync(originalsDir(v), { recursive: true });
		// COPYFILE_EXCL: two concurrent imports of the same bytes must not both write.
		try {
			fs.copyFileSync(srcAbs, path.join(originalsDir(v), name), fs.constants.COPYFILE_EXCL);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
		}
		return name;
	} catch (err) {
		logAppEvent({ kind: 'vault_error', message: `keep original failed: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}` });
		return null;
	}
}
