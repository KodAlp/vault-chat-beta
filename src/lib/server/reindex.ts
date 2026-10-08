import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { openDb, type IndexEmbeddingMeta } from '../../../indexer/db';
import { rebuildIndex, type RebuildProgress } from '../../../indexer/rebuild';
import { getEmbeddingConfig } from './providers/config-store';
import { closeVaultIndexDb } from './retrieve';
import { AppError } from './app-error';
import { scheduleConvertedImageSweep } from './converted-image-cleanup';
import type { VaultContext } from './vaults';

/**
 * Aşama 3b (embedding-bagimsizligi) — the app's in-process "reindex this
 * vault" action (`POST /api/vaults/[id]/reindex`), sharing indexer/rebuild.ts's
 * walk/embed/write loop with the CLI's `npm run index -- --full` instead of
 * shelling out to it. Two things the CLI never had to worry about, because
 * it's a one-shot process with no other reader/writer of the SAME index
 * file while it runs:
 *
 *  1. Atomicity — this module builds the new index into a SEPARATE temp file
 *     (`index.db.rebuild`) under the CURRENT embedding config, and only
 *     swaps it over the real `index.db` once the build has fully succeeded.
 *     A crash, cancellation or embed failure partway through leaves the temp
 *     file (deleted here) and the OLD index completely untouched — the app
 *     keeps answering from the old index the whole time the rebuild runs.
 *  2. Cross-process contention — the MCP server (mcp/) is a SEPARATE process
 *     that can hold its own open handle on the same index.db file. Windows
 *     refuses to rename a file that's open elsewhere (EBUSY/EPERM), so
 *     swapIndexIntoPlace() below retries with backoff and, if the lock never
 *     clears, fails with a coded error asking the user to close MCP clients
 *     — the old index is guaranteed to still be exactly where it was.
 */

/** Per-vault mutual exclusion — NOT sharedJobMutex (jobMutex.ts), which
 * serializes system-wide CPU/RAM-bound work (Ollama model swaps, document
 * conversion) and would make reindexing vault A queue behind an unrelated
 * conversion for vault B, or vice versa; that's the right behavior for THAT
 * resource, but reindex's exclusivity concern is narrower and per-vault: a
 * second reindex of the SAME vault, or an incremental write
 * (incrementalIndex.ts) landing WHILE this vault's index.db is mid-rebuild
 * or mid-swap, must be refused outright rather than silently queued (the
 * user is actively waiting on this one, unlike a background conversion).
 * incrementalIndex.ts imports `isReindexing` from this module to enforce
 * the second half of that rule. */
const activeReindexes = new Map<string, AbortController>();

export function isReindexing(vaultId: string): boolean {
	return activeReindexes.has(vaultId);
}

/** Returns false (not an error) when nothing was running — mirrors the
 * import route's cancel endpoint's forgiving shape (deleting an
 * already-gone staged file is also a no-op there). */
export function cancelReindex(vaultId: string): boolean {
	const controller = activeReindexes.get(vaultId);
	if (!controller) return false;
	controller.abort();
	return true;
}

const RENAME_ATTEMPTS = 6;
const RENAME_BACKOFF_MS = 150;
const SUFFIXES = ['', '-wal', '-shm'] as const;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function rmQuiet(p: string): void {
	fs.rmSync(p, { force: true });
}

export type RenameFn = (oldPath: string, newPath: string) => void;

/** Renames every existing `${fromBase}${suffix}` to `${toBase}${suffix}`
 * (suffix = '', '-wal', '-shm'), rolling back whichever of THIS BATCH already
 * succeeded if a later one fails partway through — so a failure never leaves
 * e.g. the main .db file moved with its -wal left behind. Returns nothing;
 * throws the renameFn's own error (with .code, e.g. 'EBUSY') on failure. */
function renameSet(renameFn: RenameFn, fromBase: string, toBase: string): void {
	const done: (typeof SUFFIXES)[number][] = [];
	try {
		for (const suf of SUFFIXES) {
			const from = `${fromBase}${suf}`;
			if (fs.existsSync(from)) {
				renameFn(from, `${toBase}${suf}`);
				done.push(suf);
			}
		}
	} catch (err) {
		for (const suf of [...done].reverse()) {
			try {
				renameFn(`${toBase}${suf}`, `${fromBase}${suf}`);
			} catch {
				// Best effort — if even the rollback fails, the outer retry loop's
				// next attempt (or, on final exhaustion, the caller's own cleanup)
				// is the last line of defense; there is nothing more to do here.
			}
		}
		throw err;
	}
}

/**
 * Swaps `tempPath` into place as `dbPath`, keeping the OLD index recoverable
 * (renamed to `${dbPath}.bak*`) until the new one is confirmed in place —
 * see the module doc comment for why this needs to retry and why it can
 * fail. `renameFn` is injectable so a test can simulate a persistent
 * EBUSY/EPERM without an actual second process holding the file open.
 *
 * On success: the old files are deleted (via `.bak`) and `tempPath` is now
 * `dbPath`. On failure (lock never clears): `dbPath` is back to exactly what
 * it was (the rollback inside renameSet, or — if even the FIRST rename
 * batch never got a chance to run — because nothing was touched yet), and
 * every `tempPath*`/`.bak*` file is removed. Throws `REINDEX_INDEX_LOCKED`.
 */
export async function swapIndexIntoPlace(dbPath: string, tempPath: string, renameFn: RenameFn = fs.renameSync): Promise<void> {
	const bakPath = `${dbPath}.bak`;
	for (let attempt = 1; ; attempt++) {
		try {
			renameSet(renameFn, dbPath, bakPath);
			try {
				renameSet(renameFn, tempPath, dbPath);
			} catch (err) {
				// The new index couldn't move into place — put the old one back
				// exactly as it was rather than leaving `dbPath` missing.
				renameSet(renameFn, bakPath, dbPath);
				throw err;
			}
			for (const suf of SUFFIXES) rmQuiet(`${bakPath}${suf}`);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
			if (!transient || attempt === RENAME_ATTEMPTS) {
				for (const suf of SUFFIXES) rmQuiet(`${tempPath}${suf}`);
				// Only drop the backup when the old index is verifiably back in
				// place: if the rollback rename above ALSO failed, `.bak` is the
				// only surviving copy of the old index and must be left on disk
				// for the next attempt (or the user) rather than deleted here.
				if (fs.existsSync(dbPath)) {
					for (const suf of SUFFIXES) rmQuiet(`${bakPath}${suf}`);
				}
				throw new AppError('REINDEX_INDEX_LOCKED', undefined, 409);
			}
			await sleep(RENAME_BACKOFF_MS * attempt);
		}
	}
}

export interface ReindexStats {
	files: number;
	chunks: number;
	ms: number;
}

export interface ReindexOptions {
	onProgress?: (p: RebuildProgress) => void;
	/** The SSE request's own abort (client disconnect) — merged with the
	 * internal controller a cancel call (cancelReindex) also aborts, so
	 * either source stops the same rebuild. */
	signal?: AbortSignal;
}

/**
 * Builds a brand-new index for `v` under the CURRENTLY configured embedding
 * (getEmbeddingConfig()) into a temp file, then atomically swaps it over the
 * real index.db. Throws `REINDEX_IN_PROGRESS` if this vault is already being
 * reindexed; propagates a `DOMException('AbortError')` on cancellation
 * (before the swap — the old index is untouched) exactly like every other
 * cancellable flow in this app (see api/chat/+server.ts).
 */
export async function reindexVault(v: VaultContext, opts: ReindexOptions = {}): Promise<ReindexStats> {
	if (activeReindexes.has(v.id)) throw new AppError('REINDEX_IN_PROGRESS', undefined, 409);

	const controller = new AbortController();
	activeReindexes.set(v.id, controller);
	const onExternalAbort = () => controller.abort();
	if (opts.signal) {
		if (opts.signal.aborted) controller.abort();
		else opts.signal.addEventListener('abort', onExternalAbort);
	}

	const tempPath = `${v.indexDbPath}.rebuild`;
	// A previous run that crashed/was killed (not cleanly cancelled) can
	// leave a stale temp file behind — never build on top of it.
	for (const suf of SUFFIXES) rmQuiet(`${tempPath}${suf}`);

	const config = getEmbeddingConfig();
	// null config = FTS-only rebuild (Aşama 4a): the new index gets chunks + keyword data, no vec table.
	const embeddingMeta: IndexEmbeddingMeta | null = config
		? { provider: config.providerId, model: config.model, dims: config.dims }
		: null;

	let db: Database.Database | null = null;
	try {
		db = openDb(tempPath, embeddingMeta);
		const stats = await rebuildIndex(db, v.libraryRoot, { onProgress: opts.onProgress, signal: controller.signal });
		db.close();
		db = null;

		if (controller.signal.aborted) throw new DOMException('Reindex aborted', 'AbortError');

		// Close every handle THIS process holds on the OLD index before
		// renaming over it — Windows refuses to rename a file with an open
		// handle, and retrieve.ts caches one connection per vault for the
		// process lifetime. A separate MCP server process's own handle is
		// exactly what swapIndexIntoPlace's retry/REINDEX_INDEX_LOCKED path
		// is for — this process has no way to close that one.
		closeVaultIndexDb(v.id);
		await swapIndexIntoPlace(v.indexDbPath, tempPath);
		scheduleConvertedImageSweep(v);

		return { files: stats.indexed, chunks: stats.chunks, ms: stats.ms };
	} catch (err) {
		if (db) {
			try {
				db.close();
			} catch {
				// Already closed or unusable — nothing left to release.
			}
		}
		for (const suf of SUFFIXES) rmQuiet(`${tempPath}${suf}`);
		throw err;
	} finally {
		if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
		activeReindexes.delete(v.id);
	}
}
