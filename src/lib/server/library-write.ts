import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveLibraryPath } from './library-read';
import { indexLibraryFile } from './incrementalIndex';
import { AppError } from './app-error';
import type { VaultContext } from './vaults';

/**
 * Manual (user-driven) editing of library source notes.
 *
 * Deliberately its OWN module, not part of library.ts and never of
 * library-read.ts: the MCP server (mcp/) imports library-read.ts and must
 * stay read-only — "the AI cannot write" is enforced structurally by
 * mcp/no-write-import.test.ts, which fails if anything under mcp/ can reach
 * this file through its import graph. The only caller is the app's own
 * /api/library/file (+ /revisions) endpoints, i.e. a human clicking Save.
 */

const META_DIR = '_meta';
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REVISIONS = 20;

// ISO timestamp with ':' and '.' replaced by '-' (Windows forbids ':' in
// file names). Anchored and exact so a revision id from the client can never
// carry a path separator or '..'.
const REVISION_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.md$/;

export type Indexer = (v: VaultContext, absPath: string, relPath: string) => Promise<void>;

export type WriteResult = { hash: string; indexPending: boolean; indexError?: string };
export type RevisionInfo = { id: string; at: string; bytes: number };

/** Hash of the exact utf-8 string — GET /api/library/file returns this same
 * value so the client can send it back as `baseHash` (optimistic lock). */
export function sha256(text: string): string {
	return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function forbidden(): AppError {
	return new AppError('LIBRARY_EDIT_FORBIDDEN', undefined, 400);
}

/**
 * Shared path gate for every function here. Returns the absolute path and the
 * normalized POSIX-style relative path (used for the revisions folder so it
 * mirrors the library layout on every OS).
 */
function checkPath(v: VaultContext, rel: string): { abs: string; relPosix: string } {
	if (typeof rel !== 'string' || rel.length === 0) throw forbidden();
	let abs: string;
	try {
		abs = resolveLibraryPath(v, rel);
	} catch {
		throw new AppError('PATH_OUTSIDE_LIBRARY', undefined, 400);
	}
	const relNative = path.relative(v.libraryRoot, abs);
	if (!relNative || relNative.startsWith('..') || path.isAbsolute(relNative)) {
		throw new AppError('PATH_OUTSIDE_LIBRARY', undefined, 400);
	}
	const segments = relNative.split(path.sep);
	// _meta holds settings, import log, attachments, and now revisions/edit-log:
	// never editable through this door. Case-insensitive because Windows/macOS
	// file systems are.
	if (segments[0].toLowerCase() === META_DIR) throw forbidden();
	if (!abs.toLowerCase().endsWith('.md')) throw forbidden();
	return { abs, relPosix: segments.join('/') };
}

/** Editing only: the file must already exist as a regular file, not a
 * symlink (a link could point outside the library, and rename-over would
 * replace the link instead of the target), and no parent directory may
 * resolve outside the library either. */
function assertEditableFile(v: VaultContext, abs: string): void {
	let st: fs.Stats;
	try {
		st = fs.lstatSync(abs);
	} catch {
		throw forbidden();
	}
	if (st.isSymbolicLink() || !st.isFile()) throw forbidden();
	const realRoot = fs.realpathSync(v.libraryRoot);
	const realFile = fs.realpathSync(abs);
	const withSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
	if (!realFile.startsWith(withSep)) throw forbidden();
}

function revisionsDir(v: VaultContext, relPosix: string): string {
	return path.join(v.libraryRoot, META_DIR, 'revisions', ...relPosix.split('/'));
}

function revisionIdFor(dir: string): string {
	// Bump by 1 ms on collision so two saves in the same millisecond still get
	// distinct, monotonically increasing names (name order == time order).
	let ms = Date.now();
	for (;;) {
		const id = new Date(ms).toISOString().replace(/[:.]/g, '-') + '.md';
		if (!fs.existsSync(path.join(dir, id))) return id;
		ms += 1;
	}
}

function atFromId(id: string): string {
	return id.slice(0, -3).replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
}

function pruneRevisions(dir: string): void {
	const ids = fs.readdirSync(dir).filter((n) => REVISION_ID.test(n)).sort();
	for (const old of ids.slice(0, Math.max(0, ids.length - MAX_REVISIONS))) {
		try {
			fs.unlinkSync(path.join(dir, old));
		} catch {
			// A stuck old revision (AV scan, open handle) must not fail the save.
		}
	}
}

/**
 * Overwrites an EXISTING library .md file with `content`, provided the file
 * on disk still hashes to `baseHash` (what the client saw when it loaded it).
 * Order matters: validate -> conflict check -> snapshot previous version ->
 * atomic replace -> log -> index. The index step runs last and never undoes
 * the save: the text on disk is the source of truth, a stale index is
 * recoverable (reindex), lost user edits are not.
 */
export async function writeLibraryFile(
	v: VaultContext,
	rel: string,
	content: string,
	baseHash: string,
	opts: { by?: 'user'; indexer?: Indexer } = {}
): Promise<WriteResult> {
	const { abs, relPosix } = checkPath(v, rel);
	assertEditableFile(v, abs);

	if (typeof content !== 'string') throw new AppError('VALIDATION_REQUIRED', { field: 'content' }, 400);
	const bytesAfter = Buffer.byteLength(content, 'utf8');
	if (bytesAfter > MAX_BYTES) throw new AppError('FILE_TOO_LARGE', { limitMb: MAX_BYTES / 1024 / 1024 }, 413);

	const previous = fs.readFileSync(abs, 'utf-8');
	if (sha256(previous) !== baseHash) throw new AppError('LIBRARY_EDIT_CONFLICT', undefined, 409);

	const revDir = revisionsDir(v, relPosix);
	fs.mkdirSync(revDir, { recursive: true });
	fs.writeFileSync(path.join(revDir, revisionIdFor(revDir)), previous, 'utf-8');
	pruneRevisions(revDir);

	// Same-directory temp file + rename: rename within one volume is atomic, so
	// a crash mid-write leaves either the old or the new file, never a torn one.
	const tmp = abs + '.tmp-' + crypto.randomBytes(6).toString('hex');
	try {
		fs.writeFileSync(tmp, content, 'utf-8');
		fs.renameSync(tmp, abs);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// temp never created or already gone
		}
		throw err;
	}

	try {
		const logPath = path.join(v.libraryRoot, META_DIR, 'edit-log.jsonl');
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.appendFileSync(
			logPath,
			JSON.stringify({
				path: relPosix,
				at: new Date().toISOString(),
				bytesBefore: Buffer.byteLength(previous, 'utf8'),
				bytesAfter,
				by: opts.by ?? 'user'
			}) + '\n',
			'utf-8'
		);
	} catch {
		// The audit log is best-effort; the save itself already succeeded.
	}

	const result: WriteResult = { hash: sha256(content), indexPending: false };
	try {
		await (opts.indexer ?? indexLibraryFile)(v, abs, relPosix);
	} catch (err) {
		result.indexPending = true;
		if (!(err instanceof AppError && err.code === 'REINDEX_IN_PROGRESS')) {
			result.indexError = err instanceof AppError ? err.code : 'INTERNAL';
		}
	}
	return result;
}

/** Newest first. Missing folder = never edited = []. */
export function listRevisions(v: VaultContext, rel: string): RevisionInfo[] {
	const { relPosix } = checkPath(v, rel);
	const dir = revisionsDir(v, relPosix);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((n) => REVISION_ID.test(n))
		.sort()
		.reverse()
		.map((id) => ({ id, at: atFromId(id), bytes: fs.statSync(path.join(dir, id)).size }));
}

export function readRevision(v: VaultContext, rel: string, id: string): string {
	const { relPosix } = checkPath(v, rel);
	if (typeof id !== 'string' || !REVISION_ID.test(id)) {
		throw new AppError('LIBRARY_REVISION_NOT_FOUND', undefined, 404);
	}
	try {
		return fs.readFileSync(path.join(revisionsDir(v, relPosix), id), 'utf-8');
	} catch {
		throw new AppError('LIBRARY_REVISION_NOT_FOUND', undefined, 404);
	}
}

/** Restoring is just another save: it snapshots the current version first, so
 * a restore can itself be undone from the revision list. */
export async function restoreRevision(
	v: VaultContext,
	rel: string,
	id: string,
	baseHash: string,
	opts: { indexer?: Indexer } = {}
): Promise<WriteResult> {
	const content = readRevision(v, rel, id);
	return writeLibraryFile(v, rel, content, baseHash, { by: 'user', indexer: opts.indexer });
}
