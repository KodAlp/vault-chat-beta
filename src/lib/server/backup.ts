import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { dataDir, chatsDbPath, providersPath } from './env';
import { listVaults, contextFor } from './vaults';
import { AppError } from './app-error';

/**
 * #61 - "Back up data" (Settings -> Vaults). Writes one timestamped folder:
 *
 *   <destination>/yedek-<stamp>/
 *     manifest.json            app version, date, per-vault counts, failures, what is excluded
 *     vaults.json              the vault registry
 *     providers.json           provider configuration (NO secrets - see below)
 *     ui-prefs.json            language + UI settings
 *     launchers.json           only if one exists in the data dir
 *     chats.db                 via better-sqlite3 .backup()
 *     vaults/<id>/library/...  the Markdown + _meta (staging and *.tmp skipped)
 *     vaults/<id>/index.db     via .backup()
 *     vaults/<id>/study.db     via .backup()
 *
 * EXCLUDED ON PURPOSE: secrets.json (API keys) and the secrets key. providers.json carries no keys (they
 * live in secrets.json, encrypted with a per-machine OS key - a copy would be unreadable on another
 * machine anyway), and a backup folder on the Desktop or a USB stick should never carry credentials. After
 * a restore the user re-enters the keys. Also left out: model-catalog.json (a re-fetched cache),
 * provider-consent.json (consent must be re-given on a new install), skills/ (user skill files are a
 * separate, tiny folder the user already holds as .md files), app-log.jsonl, and every *.tmp file.
 *
 * SQLite files go through Database#backup(), never a file copy: they run in WAL mode, where a plain copy
 * can capture half-written pages (same reasoning as scripts/backup-before-full.mjs).
 *
 * A file that cannot be read (locked by another program - Windows antivirus, an open editor) is recorded
 * in `failed` and the backup carries on; the run reports ok=false rather than throwing.
 */

export const BACKUP_FOLDER_PREFIX = 'yedek-';
export const BACKUP_DEFAULT_FOLDER_NAME = 'vault-chat-yedek';
/** What a backup never contains, written into manifest.json so a reader of the folder knows. */
export const BACKUP_EXCLUDED = [
	'secrets.json',
	'secrets.key',
	'model-catalog.json',
	'provider-consent.json',
	'skills/',
	'app-log.jsonl',
	'*.tmp',
	'_meta/staging/'
] as const;

export interface BackupFailure {
	path: string;
	error: string;
}

export interface BackupVaultSummary {
	id: string;
	name: string;
	files: number;
	bytes: number;
	databases: string[];
}

export interface BackupManifest {
	app: 'vault-chat';
	appVersion: string;
	createdAt: string;
	vaults: BackupVaultSummary[];
	counts: { files: number; databases: number; bytes: number; failed: number };
	failed: BackupFailure[];
	excluded: readonly string[];
}

export interface BackupResult {
	/** Absolute path of the folder just written. */
	folder: string;
	ok: boolean;
	manifest: BackupManifest;
}

export type BackupProgress = { done: number; total: number; path: string };

export interface BackupOptions {
	destination: string;
	onProgress?: (p: BackupProgress) => void;
	signal?: AbortSignal;
	/** Test seam; defaults to the real clock. */
	now?: Date;
}

/** Desktop if it exists (that is where scripts/backup-before-full.mjs writes), otherwise the home folder. */
export function defaultBackupDestination(): string {
	const home = os.homedir();
	const desktop = path.join(home, 'Desktop');
	const base = fs.existsSync(desktop) ? desktop : home;
	return path.join(base, BACKUP_DEFAULT_FOLDER_NAME);
}

/** realpath of the deepest existing ancestor, with the not-yet-existing tail re-appended. */
function realish(p: string): string {
	const abs = path.resolve(p);
	const tail: string[] = [];
	let cur = abs;
	for (;;) {
		try {
			return path.join(fs.realpathSync.native(cur), ...tail.reverse());
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return abs;
			tail.push(path.basename(cur));
			cur = parent;
		}
	}
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	if (rel === '') return true;
	return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Throws a coded AppError unless `destination` is a usable place for a backup folder. Returns its resolved form. */
export function validateBackupDestination(destination: string): string {
	if (typeof destination !== 'string' || destination.trim() === '' || !path.isAbsolute(destination.trim())) {
		throw new AppError('BACKUP_DEST_INVALID', undefined, 400);
	}
	const dest = realish(destination.trim());
	const forbidden = [realish(dataDir())];
	for (const v of listVaults()) {
		const c = contextFor(v);
		forbidden.push(realish(c.dir), realish(c.libraryRoot));
	}
	const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
	for (const f of forbidden) {
		if (isInside(norm(dest), norm(f))) throw new AppError('BACKUP_DEST_INSIDE_DATA', undefined, 400);
	}
	return dest;
}

function appVersion(): string {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')) as { version?: string };
		if (typeof pkg.version === 'string') return pkg.version;
	} catch {
		// packaged build: no package.json beside the sidecar
	}
	return process.env.npm_package_version ?? 'unknown';
}

function stamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Every file below `root` except *.tmp and the import staging folder. Unreadable directories are reported, not thrown. */
function walkLibrary(root: string, failed: BackupFailure[]): string[] {
	const out: string[] = [];
	const stagingRel = path.join('_meta', 'staging');
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			failed.push({ path: dir, error: err instanceof Error ? err.message : String(err) });
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (path.relative(root, full) === stagingRel) continue;
				walk(full);
			} else if (e.isFile() && !e.name.endsWith('.tmp')) {
				out.push(full);
			}
		}
	};
	if (fs.existsSync(root)) walk(root);
	return out;
}

let running = false;

export function isBackupRunning(): boolean {
	return running;
}

type Job = { kind: 'file' | 'db'; src: string; dst: string; vault?: string };

export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
	if (running) throw new AppError('BACKUP_ALREADY_RUNNING', undefined, 409);
	const dest = validateBackupDestination(opts.destination);
	running = true;
	const now = opts.now ?? new Date();
	const folder = path.join(dest, `${BACKUP_FOLDER_PREFIX}${stamp(now)}`);
	try {
		try {
			fs.mkdirSync(folder, { recursive: true });
		} catch (err) {
			throw new AppError('BACKUP_FAILED', { detail: err instanceof Error ? err.message : String(err) }, 500);
		}

		const failed: BackupFailure[] = [];
		const jobs: Job[] = [];
		const data = dataDir();

		for (const name of ['vaults.json', 'ui-prefs.json', 'launchers.json']) {
			const src = path.join(data, name);
			if (fs.existsSync(src)) jobs.push({ kind: 'file', src, dst: path.join(folder, name) });
		}
		const providers = providersPath();
		if (fs.existsSync(providers)) jobs.push({ kind: 'file', src: providers, dst: path.join(folder, 'providers.json') });
		const chats = chatsDbPath();
		if (fs.existsSync(chats)) jobs.push({ kind: 'db', src: chats, dst: path.join(folder, 'chats.db') });

		const summaries = new Map<string, BackupVaultSummary>();
		for (const rec of listVaults()) {
			const c = contextFor(rec);
			const s: BackupVaultSummary = { id: rec.id, name: rec.name, files: 0, bytes: 0, databases: [] };
			summaries.set(rec.id, s);
			const outDir = path.join(folder, 'vaults', rec.id);
			for (const file of walkLibrary(c.libraryRoot, failed)) {
				jobs.push({ kind: 'file', src: file, dst: path.join(outDir, 'library', path.relative(c.libraryRoot, file)), vault: rec.id });
			}
			if (fs.existsSync(c.indexDbPath)) jobs.push({ kind: 'db', src: c.indexDbPath, dst: path.join(outDir, 'index.db'), vault: rec.id });
			if (fs.existsSync(c.studyDbPath)) jobs.push({ kind: 'db', src: c.studyDbPath, dst: path.join(outDir, 'study.db'), vault: rec.id });
		}

		let files = 0;
		let databases = 0;
		let bytes = 0;
		const total = jobs.length;
		for (let i = 0; i < jobs.length; i++) {
			if (opts.signal?.aborted) {
				fs.rmSync(folder, { recursive: true, force: true });
				throw new DOMException('aborted', 'AbortError');
			}
			const job = jobs[i];
			try {
				fs.mkdirSync(path.dirname(job.dst), { recursive: true });
				if (job.kind === 'db') {
					const db = new Database(job.src, { readonly: true, fileMustExist: true });
					try {
						await db.backup(job.dst);
					} finally {
						db.close();
					}
				} else {
					await fs.promises.copyFile(job.src, job.dst);
				}
				const size = fs.statSync(job.dst).size;
				bytes += size;
				if (job.kind === 'db') databases++;
				else files++;
				const s = job.vault ? summaries.get(job.vault) : undefined;
				if (s) {
					if (job.kind === 'db') s.databases.push(path.basename(job.dst));
					else s.files++;
					s.bytes += size;
				}
			} catch (err) {
				try {
					fs.rmSync(job.dst, { force: true });
				} catch {
					// partial output that cannot be removed is still reported through `failed` below
				}
				failed.push({ path: job.src, error: err instanceof Error ? err.message : String(err) });
			}
			opts.onProgress?.({ done: i + 1, total, path: path.relative(data, job.src).startsWith('..') ? job.src : path.relative(data, job.src) });
		}

		const manifest: BackupManifest = {
			app: 'vault-chat',
			appVersion: appVersion(),
			createdAt: now.toISOString(),
			vaults: [...summaries.values()],
			counts: { files, databases, bytes, failed: failed.length },
			failed,
			excluded: BACKUP_EXCLUDED
		};
		fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
		return { folder, ok: failed.length === 0, manifest };
	} finally {
		running = false;
	}
}
