import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { unzipSync, type UnzipFileInfo } from 'fflate';
import type { RequestHandler } from './$types';
import { skillsDir } from '#lib/server/env.js';
import { Frontmatter, assertSafeSkillName } from '#lib/server/userSkills.js';
import { AppError, fail } from '#lib/server/app-error.js';

const MAX_ZIP_RAW_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_ENTRY_COUNT = 500;
const MAX_ZIP_ENTRY_INFLATED_BYTES = 10 * 1024 * 1024;
const MAX_ZIP_TOTAL_INFLATED_BYTES = 50 * 1024 * 1024;

/** Rejects anything that could escape the extraction root once joined with
 * it — absolute paths, drive letters, and any ".."/"." path segment. Zip
 * entry names are spec'd to use "/", but a Windows-authored zip can still
 * carry "\\" separators, so those are normalized first (same shape as
 * /api/import/+server.ts's safeBasename doing the same normalization for
 * the same reason). */
function isSafeZipEntryName(name: string): boolean {
	const norm = name.replace(/\\/g, '/');
	if (!norm || norm.endsWith('/')) return false; // empty or a directory entry, not a file
	if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return false;
	return !norm.split('/').some((segment) => segment === '..' || segment === '.' || segment === '');
}

function normalizedEntryName(name: string): string {
	return name.replace(/\\/g, '/');
}

/**
 * If every entry in the zip shares the same single top-level path segment
 * (e.g. everything under "math-tutor/"), returns that segment WITH its
 * trailing slash — this is what "Compress to ZIP file" on a folder in
 * Windows Explorer (or `Compress-Archive -Path <folder>`) always produces:
 * the folder itself becomes a wrapper directory inside the zip, which is
 * the single most natural way anyone would package a skill. Returns null
 * when there's no single common wrapper (a flat zip with files already at
 * the true root, or multiple distinct top-level entries) — no guessing
 * beyond this one unambiguous case.
 */
function findCommonWrapperPrefix(names: string[]): string | null {
	if (names.length === 0) return null;
	let prefix: string | null = null;
	for (const name of names) {
		const slash = name.indexOf('/');
		if (slash === -1) return null; // an entry already sits at the true root
		const segment = name.slice(0, slash + 1);
		if (prefix === null) prefix = segment;
		else if (prefix !== segment) return null;
	}
	return prefix;
}

/** Derives a filesystem-safe skill folder name from either the SKILL.md
 * frontmatter's own `name` or the uploaded zip's filename — lowercased,
 * stripped to [a-z0-9-_], collapsed, and finally re-validated through
 * assertSafeSkillName (the same guard writeSkill uses) so nothing here can
 * end up producing a path separator by some encoding trick this pass
 * didn't anticipate. */
function sanitizeSkillFolderName(candidate: string): string {
	const stripped = candidate
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9-_]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');
	const name = stripped || `skill-${Date.now()}`;
	assertSafeSkillName(name);
	return name;
}

/**
 * Zip upload for folder-structured skills (SKILL.md + supporting files, e.g.
 * references/*.md) — a plain .md upload only ever produces a flat skill, see
 * PUT /api/skills/[name]. Two-phase: every entry is validated (path safety +
 * size caps) BEFORE anything reaches disk, and unzipSync's `filter` callback
 * throwing on the first violation means a rejected zip never partially
 * extracts — a caught exception here always means zero bytes were written.
 *
 * Symlink entries are not specifically rejected: this endpoint never calls
 * any OS symlink-creation API in the first place — extraction is "read
 * unzipSync's returned {path: bytes} map, fs.writeFileSync each one" (see
 * below), so even a zip entry that declares itself a symlink (POSIX zip
 * convention: external attrs + content being the link target text) is just
 * written out as an ordinary file containing that text. There is no
 * extraction step anywhere that reconstructs real filesystem symlinks.
 */
export const POST: RequestHandler = async ({ request }) => {
	const formData = await request.formData();
	const file = formData.get('file');
	if (!(file instanceof File)) {
		fail('VALIDATION_REQUIRED', { field: 'Dosya' });
	}
	if (!file.name.toLowerCase().endsWith('.zip')) {
		fail('SKILL_ZIP_ONLY');
	}
	if (file.size > MAX_ZIP_RAW_BYTES) {
		fail('SKILL_ZIP_TOO_LARGE', { limitMb: MAX_ZIP_RAW_BYTES / (1024 * 1024) });
	}

	const bytes = new Uint8Array(await file.arrayBuffer());

	let entryCount = 0;
	let totalInflated = 0;
	let unzipped: Record<string, Uint8Array>;
	try {
		unzipped = unzipSync(bytes, {
			filter(entry: UnzipFileInfo) {
				if (entry.name.endsWith('/')) return false; // directory entry, nothing to extract
				entryCount++;
				if (entryCount > MAX_ZIP_ENTRY_COUNT) {
					throw new AppError('SKILL_ZIP_TOO_MANY_ENTRIES', { max: MAX_ZIP_ENTRY_COUNT });
				}
				if (!isSafeZipEntryName(entry.name)) {
					throw new AppError('SKILL_ZIP_ENTRY_PATH_INVALID', { name: entry.name });
				}
				if (entry.originalSize > MAX_ZIP_ENTRY_INFLATED_BYTES) {
					throw new AppError('SKILL_ZIP_ENTRY_TOO_BIG', { name: entry.name });
				}
				totalInflated += entry.originalSize;
				if (totalInflated > MAX_ZIP_TOTAL_INFLATED_BYTES) {
					throw new AppError('SKILL_ZIP_TOTAL_TOO_LARGE', { limitMb: MAX_ZIP_TOTAL_INFLATED_BYTES / (1024 * 1024) });
				}
				return true;
			}
		});
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		fail('SKILL_ZIP_UNZIP_FAILED', { detail: err instanceof Error ? err.message : String(err) });
	}

	// Defense in depth: re-verify actual decompressed bytes against the same
	// caps the filter already enforced against fflate's DECLARED sizes.
	let actualTotal = 0;
	for (const [name, data] of Object.entries(unzipped)) {
		actualTotal += data.byteLength;
		if (data.byteLength > MAX_ZIP_ENTRY_INFLATED_BYTES || actualTotal > MAX_ZIP_TOTAL_INFLATED_BYTES) {
			fail('SKILL_ZIP_ENTRY_TOO_BIG', { name });
		}
	}

	const entryNames = Object.keys(unzipped).map(normalizedEntryName);

	// Root first (case-insensitive — Windows' own filesystem is
	// case-insensitive, so "Skill.md" is an easy, harmless typo to never
	// notice making). Falls back to a single common wrapper folder — see
	// findCommonWrapperPrefix's doc comment for why that's the common case,
	// not an edge case.
	let wrapperPrefix = '';
	let skillMdEntry = Object.entries(unzipped).find(
		([name]) => normalizedEntryName(name).toLowerCase() === 'skill.md'
	);
	if (!skillMdEntry) {
		const commonPrefix = findCommonWrapperPrefix(entryNames);
		if (commonPrefix) {
			const wanted = (commonPrefix + 'skill.md').toLowerCase();
			const wrapped = Object.entries(unzipped).find(
				([name]) => normalizedEntryName(name).toLowerCase() === wanted
			);
			if (wrapped) {
				wrapperPrefix = commonPrefix;
				skillMdEntry = wrapped;
			}
		}
	}
	if (!skillMdEntry) {
		fail('SKILL_ZIP_MD_MISSING');
	}
	const skillMdRaw = Buffer.from(skillMdEntry[1]).toString('utf-8');

	// matter()'s own parse failure and the Frontmatter schema's validation
	// failure are handled separately on purpose — fail() throws an
	// SvelteKit HttpError, not an Error instance, so it must never be issued
	// from inside a try block that would otherwise swallow it as "err
	// instanceof Error === false" and replace it with a generic message.
	let frontmatterData: unknown;
	try {
		frontmatterData = matter(skillMdRaw).data;
	} catch (err) {
		fail('SKILL_ZIP_MD_PARSE_FAILED', { detail: err instanceof Error ? err.message : String(err) });
	}
	const result = Frontmatter.safeParse(frontmatterData);
	if (!result.success) {
		fail('SKILL_FRONTMATTER_INVALID', { detail: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
	}
	const frontmatterName = result.data.name;

	let derivedName: string;
	try {
		derivedName = sanitizeSkillFolderName(frontmatterName ?? file.name.replace(/\.zip$/i, ''));
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		throw err;
	}
	const targetDir = path.join(skillsDir(), derivedName);
	if (fs.existsSync(targetDir)) {
		fail('SKILL_EXISTS', { name: derivedName }, 409);
	}

	// Every entry already passed isSafeZipEntryName above; this is a second,
	// cheap containment check against the REAL target directory right before
	// each write — the same belt-and-suspenders shape as userSkills.ts's
	// writeSkill (path-safety check, then a second containment check right
	// before the write).
	const targetWithSep = targetDir.endsWith(path.sep) ? targetDir : targetDir + path.sep;
	fs.mkdirSync(targetDir, { recursive: true });
	try {
		for (const [name, data] of Object.entries(unzipped)) {
			const full = normalizedEntryName(name);
			// findCommonWrapperPrefix guarantees every entry starts with
			// wrapperPrefix once it's non-empty — the startsWith check is
			// defense in depth, not a real branch, matching this file's other
			// belt-and-suspenders checks.
			if (wrapperPrefix && !full.startsWith(wrapperPrefix)) continue;
			const rel = wrapperPrefix ? full.slice(wrapperPrefix.length) : full;
			if (!rel) continue; // the wrapper directory entry itself, if present as its own key
			const dest = path.join(targetDir, rel);
			if (dest !== targetDir && !dest.startsWith(targetWithSep)) {
				throw new AppError('SKILL_ZIP_ENTRY_PATH_INVALID', { name });
			}
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.writeFileSync(dest, data);
		}
	} catch (err) {
		fs.rmSync(targetDir, { recursive: true, force: true });
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		fail('SKILL_ZIP_WRITE_FAILED', { detail: err instanceof Error ? err.message : String(err) });
	}

	return Response.json({ name: derivedName });
};
