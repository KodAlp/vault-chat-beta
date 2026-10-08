import fs from 'node:fs';
import path from 'node:path';
import { CONVERTED_NAME_RE as CONVERTED_IMAGE_NAME_RE, extractConvertedImageRefs, orphanedImages, unreferencedCandidates, type StoredImage } from './image-refs';
import { logAppEvent } from './app-log';
import type { VaultContext } from './vaults';

/**
 * Removes converted images (`_meta/attachments/<sha16>.<png|jpg|jpeg>`) that no
 * note refers to any more. Three triggers, one rule:
 *  - a staged import is cancelled / discarded  -> removeImagesIfOrphaned
 *  - the periodic sweep (after an index write)  -> sweepConvertedImages
 * The rule: a file is deleted only if its name matches the converted-image shape
 * (so Obsidian attachments are untouchable) AND no .md file anywhere in the
 * library — notes, staged notes, AND note revisions — mentions it.
 *
 * Revisions count as references on purpose: restoring an old revision of a
 * note must not bring back a dead image link.
 */

/** An in-flight import copies its images before it writes the note that links them. */
export const SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Files read concurrently while collecting references; bounded so a huge vault can't open thousands of handles.
const READ_CONCURRENCY = 16;

// These two segments mirror attachments.ts (META_DIR / ATTACHMENTS_SUBDIR; a test pins them). They are not
// imported because incrementalIndex.ts imports this module, and attachments.ts -> library.ts ->
// incrementalIndex.ts would close an import cycle that breaks at load time.
const META_DIR = '_meta';
const ATTACHMENTS_SUBDIR = 'attachments';

// Not attachmentsDir(): that goes through libraryRoot(), which creates the folder — a sweep of a vault
// whose folder is gone must not resurrect it.
function attDir(v: VaultContext): string {
	return path.join(v.libraryRoot, META_DIR, ATTACHMENTS_SUBDIR);
}

async function listMarkdownFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	const attachments = path.join(root, META_DIR, ATTACHMENTS_SUBDIR);
	// Iterative walk; async readdir keeps the event loop free between directories.
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop() as string;
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const abs = path.join(dir, e.name);
			if (e.isDirectory()) {
				// Pictures and kept originals hold no Markdown links worth scanning.
				if (abs === attachments || abs === path.join(root, META_DIR, 'originals')) continue;
				stack.push(abs);
			} else if (e.isFile() && e.name.endsWith('.md')) {
				out.push(abs);
			}
		}
	}
	return out;
}

/** Names of converted images mentioned by any library Markdown file (staging and revisions included). */
export async function collectReferencedImageNames(v: VaultContext): Promise<Set<string>> {
	const files = await listMarkdownFiles(v.libraryRoot);
	const refs = new Set<string>();
	let next = 0;
	const worker = async () => {
		while (next < files.length) {
			const f = files[next++];
			try {
				for (const n of extractConvertedImageRefs(await fs.promises.readFile(f, 'utf-8'))) refs.add(n);
			} catch {
				// A file that vanished or can't be read mid-scan: skipping it could only make us delete a
				// still-referenced image if it was the sole reference, so treat any read failure as fatal below.
				throw new Error('unreadable note during reference scan');
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker));
	return refs;
}

function storedConvertedImages(v: VaultContext): StoredImage[] {
	let names: string[];
	try {
		names = fs.readdirSync(attDir(v));
	} catch {
		return [];
	}
	const out: StoredImage[] = [];
	for (const name of names) {
		if (!CONVERTED_IMAGE_NAME_RE.test(name)) continue;
		try {
			out.push({ name, mtimeMs: fs.statSync(path.join(attDir(v), name)).mtimeMs });
		} catch {
			// gone between readdir and stat
		}
	}
	return out;
}

function removeImage(v: VaultContext, name: string): boolean {
	if (!CONVERTED_IMAGE_NAME_RE.test(name)) return false;
	try {
		fs.rmSync(path.join(attDir(v), name), { force: true });
		return true;
	} catch {
		return false;
	}
}

/** Converted-image names a staged note refers to — read this BEFORE deleting the note. */
export function imageNamesInFile(abs: string): Set<string> {
	try {
		return extractConvertedImageRefs(fs.readFileSync(abs, 'utf-8'));
	} catch {
		return new Set();
	}
}

/**
 * Deletes a staged note and then the converted images only it used. The note is
 * read BEFORE it is removed (its links are the only record of which images it
 * owned) and deleted BEFORE the reference scan, so it does not keep its own
 * images alive. Image cleanup never throws; a failure just leaves an orphan for
 * the periodic sweep.
 */
export async function discardStagedNote(v: VaultContext, stagedAbs: string): Promise<number> {
	const names = imageNamesInFile(stagedAbs);
	fs.rmSync(stagedAbs, { force: true });
	return removeImagesIfOrphaned(v, names);
}

/**
 * After a note is discarded (its file already deleted): removes each of
 * `candidates` that no remaining library file references. Never throws — a
 * failed cleanup leaves an orphan for the periodic sweep, it must not fail the
 * cancel itself. Returns how many files it deleted.
 */
export async function removeImagesIfOrphaned(v: VaultContext, candidates: Iterable<string>): Promise<number> {
	const list = [...candidates].filter((n) => CONVERTED_IMAGE_NAME_RE.test(n));
	if (list.length === 0) return 0;
	try {
		const referenced = await collectReferencedImageNames(v);
		let removed = 0;
		for (const name of unreferencedCandidates(list, referenced)) if (removeImage(v, name)) removed++;
		return removed;
	} catch {
		return 0;
	}
}

export interface SweepResult {
	/** converted-image files present in the attachments folder */
	scanned: number;
	removed: number;
	/** true when the reference scan was skipped because no file was old enough to be deleted anyway */
	skippedScan: boolean;
}

/**
 * Deletes converted images nothing references and that are older than
 * `minAgeMs`. Cheap in the common case: if no converted image is old enough,
 * the (comparatively expensive) walk over every note is skipped entirely.
 */
export async function sweepConvertedImages(v: VaultContext, opts: { nowMs?: number; minAgeMs?: number } = {}): Promise<SweepResult> {
	const nowMs = opts.nowMs ?? Date.now();
	const minAgeMs = opts.minAgeMs ?? SWEEP_MIN_AGE_MS;
	const stored = storedConvertedImages(v);
	if (!stored.some((s) => nowMs - s.mtimeMs >= minAgeMs)) return { scanned: stored.length, removed: 0, skippedScan: true };
	const referenced = await collectReferencedImageNames(v);
	let removed = 0;
	for (const name of orphanedImages(stored, referenced, nowMs, minAgeMs)) if (removeImage(v, name)) removed++;
	return { scanned: stored.length, removed, skippedScan: false };
}

const lastSweep = new Map<string, number>();

/**
 * Fire-and-forget sweep, at most once per vault per SWEEP_INTERVAL_MS per
 * process. Called after a successful index write: that is the moment library
 * content changed, and a vault nobody indexes into has nothing new to orphan.
 * Runs on a later tick and is unref'd, so it never delays the request that
 * triggered it nor keeps the process alive. Logs counts only (no paths).
 */
export function scheduleConvertedImageSweep(v: VaultContext): void {
	const now = Date.now();
	const last = lastSweep.get(v.id);
	if (last !== undefined && now - last < SWEEP_INTERVAL_MS) return;
	lastSweep.set(v.id, now);
	const timer = setTimeout(() => {
		sweepConvertedImages(v)
			.then((r) => {
				if (r.removed > 0) logAppEvent({ kind: 'image_cleanup', message: `swept ${r.removed} of ${r.scanned} converted images` });
			})
			.catch(() => {
				// A failed sweep is retried at the next interval; there is nothing for the caller to do.
			});
	}, 0);
	timer.unref();
}

/** Test seam: forget throttle state. */
export function resetSweepThrottle(): void {
	lastSweep.clear();
}
