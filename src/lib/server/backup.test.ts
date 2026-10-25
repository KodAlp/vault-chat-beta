import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createVault, contextFor } from './vaults';
import { runBackup, validateBackupDestination, defaultBackupDestination, BACKUP_FOLDER_PREFIX } from './backup';
import { AppError } from './app-error';

// DATA_DIR is process-global, so everything runs inside one sequential test (same approach as vaults.test.ts).
test('backup', async (t) => {
	const savedEnv = { ...process.env };
	// realpath: runBackup resolves the destination (macOS /var -> /private/var, Windows 8.3 short names
	// such as RUNNER~1), so the expected paths must be in the same resolved form.
	const tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-backup-test-')));
	const dataRoot = path.join(tmpRoot, 'data');
	const destRoot = path.join(tmpRoot, 'dest');
	fs.mkdirSync(dataRoot, { recursive: true });
	process.env.DATA_DIR = dataRoot;
	delete process.env.CHATS_DB_PATH;
	delete process.env.PROVIDERS_PATH;
	delete process.env.SECRETS_PATH;

	const rec = createVault('Matematik');
	const ctx = contextFor(rec);
	fs.mkdirSync(path.join(ctx.libraryRoot, 'Analiz'), { recursive: true });
	fs.writeFileSync(path.join(ctx.libraryRoot, 'Analiz', 'limit.md'), '# Limit\n');
	fs.mkdirSync(path.join(ctx.libraryRoot, '_meta', 'staging'), { recursive: true });
	fs.writeFileSync(path.join(ctx.libraryRoot, '_meta', 'staging', 'x.md'), 'staged');
	fs.writeFileSync(path.join(ctx.libraryRoot, '_meta', 'import-log.jsonl'), '{}\n');
	fs.writeFileSync(path.join(ctx.libraryRoot, 'Analiz', 'half.md.tmp'), 'partial');

	const openDbs: Database.Database[] = [];
	for (const [file, rows] of [
		[ctx.indexDbPath, 3],
		[ctx.studyDbPath, 2],
		[path.join(dataRoot, 'chats.db'), 1]
	] as const) {
		const db = new Database(file);
		db.pragma('journal_mode = WAL');
		db.exec('CREATE TABLE t (n INTEGER)');
		for (let i = 0; i < rows; i++) db.prepare('INSERT INTO t VALUES (?)').run(i);
		// Left open on purpose: with an open WAL connection the rows may live only in the -wal file.
		openDbs.push(db);
	}
	fs.writeFileSync(path.join(dataRoot, 'providers.json'), '{"providers":[]}');
	fs.writeFileSync(path.join(dataRoot, 'ui-prefs.json'), '{"locale":"tr"}');
	fs.writeFileSync(path.join(dataRoot, 'secrets.json'), 'TOP-SECRET');
	fs.writeFileSync(path.join(dataRoot, 'secrets.key'), 'TOP-SECRET-KEY');

	await t.test('produces the expected files and a manifest', async () => {
		const progress: number[] = [];
		const res = await runBackup({ destination: destRoot, onProgress: (p) => progress.push(p.done) });
		assert.equal(res.ok, true);
		assert.ok(path.basename(res.folder).startsWith(BACKUP_FOLDER_PREFIX));
		assert.ok(res.folder.startsWith(destRoot));
		const f = (...p: string[]) => path.join(res.folder, ...p);
		for (const rel of [
			['vaults.json'],
			['providers.json'],
			['ui-prefs.json'],
			['chats.db'],
			['manifest.json'],
			['vaults', 'matematik', 'index.db'],
			['vaults', 'matematik', 'study.db'],
			['vaults', 'matematik', 'library', 'Analiz', 'limit.md'],
			['vaults', 'matematik', 'library', '_meta', 'import-log.jsonl']
		]) {
			assert.ok(fs.existsSync(f(...rel)), rel.join('/'));
		}
		assert.ok(!fs.existsSync(f('launchers.json')));
		assert.ok(!fs.existsSync(f('vaults', 'matematik', 'library', '_meta', 'staging')), 'staging skipped');
		assert.ok(!fs.existsSync(f('vaults', 'matematik', 'library', 'Analiz', 'half.md.tmp')), '*.tmp skipped');
		const manifest = JSON.parse(fs.readFileSync(f('manifest.json'), 'utf-8'));
		assert.equal(manifest.app, 'vault-chat');
		assert.equal(manifest.vaults[0].id, 'matematik');
		assert.deepEqual(manifest.vaults[0].databases.sort(), ['index.db', 'study.db']);
		assert.equal(manifest.counts.failed, 0);
		assert.ok(progress.length > 0 && progress[progress.length - 1] === progress.length);
	});

	await t.test('databases are restorable', async () => {
		const res = await runBackup({ destination: destRoot, now: new Date(Date.now() + 5000) });
		for (const [rel, rows] of [
			[['vaults', 'matematik', 'index.db'], 3],
			[['vaults', 'matematik', 'study.db'], 2],
			[['chats.db'], 1]
		] as const) {
			const db = new Database(path.join(res.folder, ...rel), { readonly: true });
			const n = (db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;
			db.close();
			assert.equal(n, rows, rel.join('/'));
		}
	});

	await t.test('secrets are never copied', async () => {
		const res = await runBackup({ destination: destRoot, now: new Date(Date.now() + 10000) });
		const all: string[] = [];
		const walk = (d: string) => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) walk(p);
				else all.push(p);
			}
		};
		walk(res.folder);
		assert.ok(all.every((p) => !/secrets\./.test(path.basename(p))));
		assert.ok(all.every((p) => !fs.readFileSync(p).includes('TOP-SECRET')));
	});

	await t.test('destination inside the data dir or a vault is rejected', async () => {
		for (const dest of [dataRoot, path.join(dataRoot, 'backups'), ctx.libraryRoot, path.join(ctx.libraryRoot, 'Analiz', 'yedek')]) {
			await assert.rejects(
				() => runBackup({ destination: dest }),
				(err: unknown) => err instanceof AppError && err.code === 'BACKUP_DEST_INSIDE_DATA',
				dest
			);
		}
		assert.ok(!fs.existsSync(path.join(dataRoot, 'backups')));
	});

	await t.test('relative or empty destination is rejected', () => {
		for (const dest of ['', '   ', 'relative/path']) {
			assert.throws(() => validateBackupDestination(dest), (err: unknown) => err instanceof AppError && err.code === 'BACKUP_DEST_INVALID');
		}
	});

	await t.test('default destination is an absolute vault-chat-yedek path', () => {
		const d = defaultBackupDestination();
		assert.ok(path.isAbsolute(d));
		assert.equal(path.basename(d), 'vault-chat-yedek');
	});

	await t.test('an unreadable file is reported and the backup continues', async () => {
		// A corrupt database stands in for a locked file: .backup() throws, the run must report it and carry on.
		openDbs.find((d) => d.name === ctx.studyDbPath)?.close();
		fs.writeFileSync(ctx.studyDbPath, 'this is not a sqlite database');
		const res = await runBackup({ destination: destRoot, now: new Date(Date.now() + 20000) });
		assert.equal(res.ok, false);
		assert.equal(res.manifest.counts.failed, 1);
		assert.ok(res.manifest.failed[0].path.endsWith('study.db'));
		assert.ok(fs.existsSync(path.join(res.folder, 'vaults', 'matematik', 'index.db')), 'other files still backed up');
		assert.ok(!fs.existsSync(path.join(res.folder, 'vaults', 'matematik', 'study.db')), 'partial output removed');
	});

	for (const d of openDbs) if (d.open) d.close();
	process.env = savedEnv;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});
