import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Directory move used by the legacy-library -> vault migration. A same-volume
 * rename is tried first; when it fails (EXDEV across filesystems, a lock) the
 * tree is COPIED, the copy is VERIFIED against the source (same set of relative
 * file paths, same sizes), and only then is the source deleted. Any failure
 * leaves the source untouched and throws an Error whose `code` is one of
 * MIGRATE_COPY_FAILED / MIGRATE_COPY_VERIFY_FAILED.
 *
 * Why this exists: the old code ran `robocopy` and treated "no exit status"
 * (spawn failure — robocopy does not exist on Linux/macOS) as success, then
 * deleted the never-copied source.
 */
export type MigrateErrorCode = 'MIGRATE_COPY_FAILED' | 'MIGRATE_COPY_VERIFY_FAILED';

export class MigrateError extends Error {
	code: MigrateErrorCode;
	constructor(code: MigrateErrorCode, message: string, cause?: unknown) {
		super(`[${code}] ${message}`);
		this.name = 'MigrateError';
		this.code = code;
		if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
	}
}

/** Relative file path (posix separators) -> size in bytes, for every file under dir. */
export function listTree(dir: string): Map<string, number> {
	const out = new Map<string, number>();
	const walk = (cur: string, rel: string): void => {
		for (const entry of readdirSync(cur, { withFileTypes: true })) {
			const abs = path.join(cur, entry.name);
			const r = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(abs, r);
			else out.set(r, statSync(abs).size);
		}
	};
	walk(dir, '');
	return out;
}

/** Problems found comparing two trees; empty array = identical file set and sizes. */
export function diffTrees(src: Map<string, number>, dest: Map<string, number>): string[] {
	const problems: string[] = [];
	for (const [rel, size] of src) {
		if (!dest.has(rel)) problems.push(`eksik: ${rel}`);
		else if (dest.get(rel) !== size) problems.push(`boyut farklı: ${rel} (${size} != ${dest.get(rel)})`);
	}
	for (const rel of dest.keys()) if (!src.has(rel)) problems.push(`fazla: ${rel}`);
	return problems;
}

/** robocopy exit codes 0-7 = success; >=8 = failure; null status (spawn failed / killed) = failure. */
export function robocopyFailed(status: number | null, error?: Error): boolean {
	return error !== undefined || status === null || status >= 8;
}

function defaultCopier(src: string, dest: string): void {
	if (process.platform === 'win32') {
		const r = spawnSync('robocopy', [src, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS'], {
			stdio: 'ignore'
		});
		if (robocopyFailed(r.status, r.error)) {
			throw new Error(`robocopy başarısız (status=${r.status}${r.error ? `, ${r.error.message}` : ''})`);
		}
		return;
	}
	cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
}

export interface MoveDirDeps {
	rename?: (src: string, dest: string) => void;
	copy?: (src: string, dest: string) => void;
	remove?: (p: string) => void;
	log?: (msg: string) => void;
}

function isEmptyDir(p: string): boolean {
	try {
		return readdirSync(p).length === 0;
	} catch {
		return true;
	}
}

export function moveDirSafe(src: string | undefined, dest: string, deps: MoveDirDeps = {}): void {
	const rename = deps.rename ?? renameSync;
	const copy = deps.copy ?? defaultCopier;
	const remove = deps.remove ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
	const log = deps.log ?? (() => {});

	if (!src || !existsSync(src)) {
		mkdirSync(dest, { recursive: true });
		return;
	}
	try {
		rename(src, dest);
		return;
	} catch (err) {
		log(`renameSync başarısız (${(err as Error).message}), kopyalamaya düşülüyor...`);
	}

	const destWasEmpty = !existsSync(dest) || isEmptyDir(dest);
	mkdirSync(dest, { recursive: true });
	const abandonPartialCopy = (): void => {
		// Only clean up what this attempt could have created — never a dest that already had content.
		if (destWasEmpty) {
			try {
				remove(dest);
			} catch {
				/* best effort */
			}
		}
	};

	try {
		copy(src, dest);
	} catch (err) {
		abandonPartialCopy();
		throw new MigrateError('MIGRATE_COPY_FAILED', `${src} -> ${dest} kopyalanamadı; kaynak silinmedi`, err);
	}

	let problems: string[];
	try {
		problems = diffTrees(listTree(src), listTree(dest));
	} catch (err) {
		abandonPartialCopy();
		throw new MigrateError('MIGRATE_COPY_VERIFY_FAILED', `${dest} doğrulanamadı; kaynak silinmedi`, err);
	}
	if (problems.length > 0) {
		abandonPartialCopy();
		throw new MigrateError(
			'MIGRATE_COPY_VERIFY_FAILED',
			`kopya kaynakla eşleşmiyor (${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` ... +${problems.length - 5}` : ''}); kaynak silinmedi`
		);
	}

	// Güvenlik sertleştirme: fs.rmSync, no shell involved (see git history for the PowerShell injection it replaced).
	remove(src);
}
