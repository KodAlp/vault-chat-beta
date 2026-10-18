#!/usr/bin/env node
// Yerel + CI güvenlik denetimi: npm audit, cargo audit, gitleaks.
// Kullanım: node scripts/security-audit.mjs [--only=npm,cargo,gitleaks]
// CI ortam değişkeni tanımlıysa eksik araç hata sayılır.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isCI = Boolean(process.env.CI);
const isWin = process.platform === 'win32';

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()) : ['npm', 'cargo', 'gitleaks'];

/** Komutu çalıştırır; stdout/stderr'i toplar. */
function run(cmd, args, cwd, { stream = false } = {}) {
	const r = spawnSync(cmd, args, {
		cwd,
		encoding: 'utf8',
		shell: isWin && cmd === 'npm', // npm.cmd
		maxBuffer: 64 * 1024 * 1024,
		stdio: stream ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe']
	});
	return { status: r.status, error: r.error, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function have(cmd, args = ['--version']) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', shell: isWin && cmd === 'npm', stdio: 'pipe' });
	return !r.error && r.status === 0;
}

const rows = [];
const add = (name, status, detail) => rows.push({ name, status, detail });
const skipped = (name, hint) => add(name, isCI ? 'FAIL' : 'skipped', hint + (isCI ? ' (CI: araç şart)' : ''));

function npmAudit(label, cwd) {
	console.log(`\n== npm audit (${label}) ==`);
	// Okunabilir çıktı
	const human = run('npm', ['audit', '--omit=dev', '--audit-level=high'], cwd);
	process.stdout.write(human.stdout + human.stderr);
	// Sayım için JSON
	const j = run('npm', ['audit', '--omit=dev', '--json'], cwd);
	let counts = null;
	try {
		counts = JSON.parse(j.stdout).metadata?.vulnerabilities ?? null;
	} catch {
		/* ağ hatası vb. */
	}
	if (!counts) {
		add(`npm (${label})`, 'FAIL', 'npm audit sonucu okunamadı (ağ?)');
		return;
	}
	const { info = 0, low = 0, moderate = 0, high = 0, critical = 0 } = counts;
	const detail = `critical ${critical}, high ${high}, moderate ${moderate}, low ${low}, info ${info}`;
	add(`npm (${label})`, high + critical > 0 ? 'FAIL' : 'ok', detail);
}

if (only.includes('npm')) {
	npmAudit('kök', root);
	// mcp/ kendi package-lock.json'una sahipse ayrıca denetle
	if (existsSync(join(root, 'mcp', 'package-lock.json'))) npmAudit('mcp', join(root, 'mcp'));
}

if (only.includes('cargo')) {
	console.log('\n== cargo audit ==');
	if (!have('cargo', ['audit', '--version'])) {
		skipped('cargo audit', 'cargo install cargo-audit --locked');
	} else {
		const r = run('cargo', ['audit'], join(root, 'src-tauri'), { stream: true });
		add('cargo audit', r.status === 0 ? 'ok' : 'FAIL', r.status === 0 ? 'zafiyet yok' : `çıkış kodu ${r.status}`);
	}
}

if (only.includes('gitleaks')) {
	console.log('\n== gitleaks ==');
	if (!have('gitleaks', ['version'])) {
		skipped('gitleaks', 'winget install Gitleaks.Gitleaks / brew install gitleaks');
	} else {
		const r = run('gitleaks', ['detect', '--source', '.', '--redact', '--no-banner'], root, { stream: true });
		add('gitleaks', r.status === 0 ? 'ok' : 'FAIL', r.status === 0 ? 'sızıntı yok' : `çıkış kodu ${r.status} (bulgu var)`);
	}
}

console.log('\n== Özet ==');
const w = Math.max(...rows.map((r) => r.name.length), 5);
for (const r of rows) console.log(`${r.name.padEnd(w)}  ${r.status.padEnd(7)}  ${r.detail}`);
const failed = rows.some((r) => r.status === 'FAIL');
process.exit(failed ? 1 : 0);
