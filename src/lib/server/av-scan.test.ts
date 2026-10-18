import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	createAvScanner,
	classifyDefender,
	classifyClam,
	comparePlatformFolders,
	findMpCmdRun,
	parseDefenderThreat,
	type AvRunner,
	type RunnerResult
} from './av-scan';
import { assertFileClean, resetAvGuardWarnings } from './av-guard';
import { readAvSettings, writeAvSettings } from './av-settings';
import { AppError } from './app-error';

const ok = (over: Partial<RunnerResult> = {}): RunnerResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...over });

const WIN_ENV = { ProgramData: 'C:\\ProgramData', ProgramFiles: 'C:\\Program Files', PATH: '' };
const DEFENDER_OLD = 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.25080.5-0\\MpCmdRun.exe';
const DEFENDER_NEW = 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.26050.15-0\\MpCmdRun.exe';

function winScanner(runner: AvRunner, now = () => 1000) {
	const files = new Set([DEFENDER_OLD, DEFENDER_NEW]);
	return createAvScanner({
		runner,
		platform: 'win32',
		env: WIN_ENV,
		exists: (p) => files.has(p),
		listDir: () => ['4.18.25080.5-0', '4.18.26050.15-0', '4.18.26030.3011-0'],
		now
	});
}

test('platform folders sort newest first, numerically', () => {
	const sorted = ['4.18.9.1-0', '4.18.26050.15-0', '4.18.26030.3011-0'].sort(comparePlatformFolders);
	assert.deepEqual(sorted, ['4.18.26050.15-0', '4.18.26030.3011-0', '4.18.9.1-0']);
});

test('findMpCmdRun picks the newest platform folder, falls back to Program Files', () => {
	const files = new Set([DEFENDER_OLD, DEFENDER_NEW]);
	const base = { env: WIN_ENV, exists: (p: string) => files.has(p), listDir: () => ['4.18.25080.5-0', '4.18.26050.15-0'] };
	assert.equal(findMpCmdRun(base), DEFENDER_NEW);
	const pf = 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe';
	assert.equal(findMpCmdRun({ ...base, exists: (p) => p === pf, listDir: () => [] }), pf);
	assert.equal(findMpCmdRun({ ...base, exists: () => false }), null);
});

test('Defender exit 0 is clean and the command line is exactly the documented one', async () => {
	const calls: { cmd: string; args: string[]; timeout: number }[] = [];
	const s = winScanner(async (cmd, args, timeout) => {
		calls.push({ cmd, args, timeout });
		return ok();
	});
	const r = await s.scanFile('C:\\tmp\\a b.pdf');
	assert.equal(r.status, 'clean');
	assert.equal(r.engine, 'defender');
	assert.equal(calls[0].cmd, DEFENDER_NEW);
	assert.deepEqual(calls[0].args, ['-Scan', '-ScanType', '3', '-File', path.resolve('C:\\tmp\\a b.pdf'), '-DisableRemediation']);
	assert.equal(calls[0].timeout, 60_000);
});

test('Defender exit 2 with a threat report is infected and carries the name', () => {
	const out =
		'Scan starting...\nScan finished.\nFound 1 threats.\n\nThreat                  : Virus:DOS/EICAR_Test_File\nResources               : 1 total\n';
	assert.deepEqual(classifyDefender(ok({ code: 2, stdout: out })), { status: 'infected', threat: 'Virus:DOS/EICAR_Test_File' });
	assert.equal(parseDefenderThreat('nothing here'), undefined);
	assert.deepEqual(classifyDefender(ok({ code: 2, stdout: 'x' })), { status: 'infected', threat: 'unknown' });
});

test('Defender exit 2 with "Failed with hr = 0x80004005" (disabled Defender, measured) is unavailable, not infected', () => {
	const out = '[Failed][0x80004005] Unspecified error\nCmdTool: Failed with hr = 0x80004005. Check MpCmdRun.log for more information\n';
	assert.equal(classifyDefender(ok({ code: 2, stdout: out })).status, 'unavailable');
	assert.equal(classifyDefender(ok({ code: 2, stdout: 'CmdTool: Failed with hr = 0x80070005.' })).status, 'error');
	assert.equal(classifyDefender(ok({ code: 7 })).status, 'error');
});

test('timeouts and spawn failures', () => {
	assert.equal(classifyDefender(ok({ code: null, timedOut: true })).status, 'error');
	assert.equal(classifyDefender(ok({ code: null, spawnError: 'ENOENT' })).status, 'unavailable');
	assert.equal(classifyClam(ok({ code: null, timedOut: true }), false).status, 'error');
});

test('ClamAV exit codes: 0 clean, 1 infected (FOUND parsed), 2 error, daemon down = unavailable', () => {
	assert.equal(classifyClam(ok({ code: 0 }), false).status, 'clean');
	assert.deepEqual(classifyClam(ok({ code: 1, stdout: '/tmp/x: Win.Test.EICAR_HDB-1 FOUND\n' }), false), {
		status: 'infected',
		threat: 'Win.Test.EICAR_HDB-1'
	});
	assert.equal(classifyClam(ok({ code: 2, stderr: 'ERROR: bad db' }), false).status, 'error');
	assert.equal(classifyClam(ok({ code: 2, stderr: 'ERROR: Could not connect to clamd on LocalSocket' }), true).status, 'unavailable');
});

function linuxScanner(runner: AvRunner, bins: string[]) {
	return createAvScanner({
		runner,
		platform: 'linux',
		env: { PATH: '/usr/bin:/bin' },
		exists: (p) => bins.includes(p),
		listDir: () => []
	});
}

test('Linux prefers clamdscan with --fdpass, else clamscan; no scanner = unavailable', async () => {
	const seen: string[][] = [];
	const run: AvRunner = async (cmd, args) => {
		seen.push([cmd, ...args]);
		return ok();
	};
	await linuxScanner(run, ['/usr/bin/clamdscan', '/usr/bin/clamscan']).scanFile('/tmp/f.pdf');
	assert.deepEqual(seen[0], ['/usr/bin/clamdscan', '--no-summary', '--fdpass', path.resolve('/tmp/f.pdf')]);
	seen.length = 0;
	const r = await linuxScanner(run, ['/usr/bin/clamscan']).scanFile('/tmp/f.pdf');
	assert.deepEqual(seen[0], ['/usr/bin/clamscan', '--no-summary', path.resolve('/tmp/f.pdf')]);
	assert.equal(r.engine, 'clamav');
	const none = await linuxScanner(run, []).scanFile('/tmp/f.pdf');
	assert.equal(none.status, 'unavailable');
});

test('clamdscan without a daemon falls through to clamscan', async () => {
	const run: AvRunner = async (cmd) =>
		cmd.endsWith('clamdscan') ? ok({ code: 2, stderr: 'Could not connect to clamd' }) : ok({ code: 1, stdout: '/f: Eicar-Signature FOUND' });
	const r = await linuxScanner(run, ['/usr/bin/clamdscan', '/usr/bin/clamscan']).scanFile('/f');
	assert.equal(r.status, 'infected');
	assert.equal(r.threat, 'Eicar-Signature');
});

test('an unavailable engine is not respawned for every file; detection is cached', async () => {
	let spawns = 0;
	let t = 1000;
	const s = winScanner(
		async () => {
			spawns++;
			return ok({ code: 2, stdout: 'CmdTool: Failed with hr = 0x80004005.' });
		},
		() => t
	);
	assert.equal((await s.scanFile('a')).status, 'unavailable');
	assert.equal((await s.scanFile('b')).status, 'unavailable');
	assert.equal(spawns, 1);
	t += 61_000;
	await s.scanFile('c');
	assert.equal(spawns, 2);
});

test('timeout option is passed through and reported as error', async () => {
	let seenTimeout = 0;
	const s = winScanner(async (_c, _a, timeout) => {
		seenTimeout = timeout;
		return ok({ code: null, timedOut: true });
	});
	const r = await s.scanFile('x', { timeoutMs: 5 });
	assert.equal(seenTimeout, 5);
	assert.equal(r.status, 'error');
	assert.equal(r.detail, 'timeout');
});

// --- policy (av-guard) ---

function guardDeps(status: 'clean' | 'infected' | 'unavailable' | 'error', enabled = true) {
	const logs: { kind: string; message: string }[] = [];
	return {
		logs,
		deps: {
			enabled: () => enabled,
			scan: async () => ({ status, engine: 'defender' as const, threat: status === 'infected' ? 'EICAR' : undefined, ms: 12, detail: 'd' }),
			log: (r: { kind: string; message: string }) => void logs.push(r)
		}
	};
}

test('guard: infected rejects with FILE_THREAT_DETECTED and the threat name', async () => {
	const g = guardDeps('infected');
	await assert.rejects(
		() => assertFileClean('f', g.deps as never),
		(e) => e instanceof AppError && e.code === 'FILE_THREAT_DETECTED' && e.params?.threat === 'EICAR'
	);
	assert.equal(g.logs[0].kind, 'av_threat');
});

test('guard: unavailable proceeds and logs once per process; error proceeds and logs every time', async () => {
	resetAvGuardWarnings();
	const u = guardDeps('unavailable');
	await assertFileClean('a', u.deps as never);
	await assertFileClean('b', u.deps as never);
	assert.deepEqual(
		u.logs.map((l) => l.kind),
		['av_unavailable']
	);
	const e = guardDeps('error');
	await assertFileClean('a', e.deps as never);
	await assertFileClean('b', e.deps as never);
	assert.deepEqual(
		e.logs.map((l) => l.kind),
		['av_error', 'av_error']
	);
});

test('guard: setting off skips the scan entirely; clean is silent', async () => {
	let scanned = false;
	const off = {
		enabled: () => false,
		scan: async () => {
			scanned = true;
			return { status: 'clean' as const, ms: 0 };
		},
		log: () => {}
	};
	assert.equal(await assertFileClean('f', off), null);
	assert.equal(scanned, false);
	const c = guardDeps('clean');
	await assertFileClean('f', c.deps as never);
	assert.equal(c.logs.length, 0);
});

// --- setting ---

test('avScan setting: on by default, persists, rejects non-booleans, corrupt file reads as on', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-settings-test-'));
	process.env.DATA_DIR = dir;
	assert.deepEqual(readAvSettings(), { avScan: true });
	assert.deepEqual(writeAvSettings({ avScan: false }), { avScan: false });
	assert.deepEqual(readAvSettings(), { avScan: false });
	assert.deepEqual(writeAvSettings({}), { avScan: false });
	assert.throws(
		() => writeAvSettings({ avScan: 'no' }),
		(e) => e instanceof AppError && e.code === 'VALIDATION_INVALID'
	);
	fs.writeFileSync(path.join(dir, 'av-settings.json'), '{not json');
	assert.deepEqual(readAvSettings(), { avScan: true });
});
