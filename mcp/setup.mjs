#!/usr/bin/env node
// One-command MCP setup from a source checkout: picks the data dir, registers
// the server in the MCP clients found on this machine (backing their config
// files up first) and creates a small, indexed sample vault. This is a normal
// CLI, not the stdio MCP server, so writing to stdout is fine here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
	SERVER_NAME,
	resolveDataDir,
	claudeDesktopConfigPath,
	lmStudioConfigPath,
	serverEntry,
	configBlock,
	mergeServerEntry,
	backupName,
	claudeCodeArgs
} from './setup-lib.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const launchPath = fileURLToPath(new URL('./launch.mjs', import.meta.url));
const sampleDir = fileURLToPath(new URL('./sample-vault/', import.meta.url));
const SAMPLE_NAME = 'Örnek Kasa';
const ALL_CLIENTS = ['claude-desktop', 'claude-code', 'lm-studio'];
const CLIENT_LABEL = { 'claude-desktop': 'Claude Desktop', 'claude-code': 'Claude Code', 'lm-studio': 'LM Studio' };

const USAGE = `vault-chat-mcp: MCP sunucusunu tek komutla kurar

Kullanım:
  vault-chat-mcp setup [--client claude-desktop,claude-code,lm-studio]
                       [--data-dir <klasör>] [--no-sample] [--dry-run]
  vault-chat-mcp config [--data-dir <klasör>]   Yapılandırma bloğunu yazdırır
  vault-chat-mcp --help

setup şunları yapar:
  1. Veri klasörünü seçer (--data-dir > DATA_DIR > kurulu uygulamanın klasörü > <repo>/data)
  2. Bulunan MCP istemcilerine kaydeder (dosyaların yedeğini alarak)
  3. "${SAMPLE_NAME}" adlı küçük bir örnek kasa oluşturup indeksler
`;

function parseArgs(argv) {
	const out = { cmd: null, client: null, dataDir: null, noSample: false, dryRun: false, help: false };
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const val = (name) => {
			if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
			const v = argv[++i];
			if (v === undefined) throw new Error(`${name} için bir değer gerekli.`);
			return v;
		};
		if (a === '--help' || a === '-h') out.help = true;
		else if (a === '--no-sample') out.noSample = true;
		else if (a === '--dry-run') out.dryRun = true;
		else if (a === '--client' || a.startsWith('--client=')) out.client = val('--client').split(',').map((s) => s.trim()).filter(Boolean);
		else if (a === '--data-dir' || a.startsWith('--data-dir=')) out.dataDir = val('--data-dir');
		else if (a.startsWith('-')) throw new Error(`Bilinmeyen seçenek: ${a}`);
		else rest.push(a);
	}
	out.cmd = rest[0] ?? null;
	return out;
}

function homeDir() {
	return (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || process.env.HOME || os.homedir();
}

function loadDotEnv() {
	try {
		process.loadEnvFile(path.join(repoRoot, '.env'));
	} catch {
		// .env is optional
	}
}

function pickDataDir(flag) {
	return resolveDataDir({
		flag,
		envDataDir: process.env.DATA_DIR && process.env.DATA_DIR.length > 0 ? process.env.DATA_DIR : null,
		platform: process.platform,
		env: process.env,
		home: homeDir(),
		repoRoot,
		exists: (p) => fs.existsSync(p)
	});
}

const SOURCE_LABEL = {
	flag: '--data-dir',
	env: 'DATA_DIR ortam değişkeni',
	app: 'kurulu masaüstü uygulamasının klasörü',
	repo: 'repo içindeki varsayılan data/'
};

/** Absolute path of an executable on PATH, or null. On Windows tries .exe before .cmd. */
function findOnPath(name) {
	const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
	for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const full = path.join(dir, name + ext);
			try {
				if (fs.statSync(full).isFile()) return full;
			} catch {
				// not here
			}
		}
	}
	return null;
}

function detectClients(paths) {
	const found = [];
	if (fs.existsSync(path.dirname(paths.desktop))) found.push('claude-desktop');
	if (findOnPath('claude')) found.push('claude-code');
	if (fs.existsSync(path.dirname(paths.lmstudio))) found.push('lm-studio');
	return found;
}

function atomicWrite(file, text) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, text, 'utf-8');
	fs.renameSync(tmp, file);
}

/** Writes one JSON config file. Returns a status line. */
function writeJsonClient({ label, file, entry, explicit, dryRun }) {
	const dirExists = fs.existsSync(path.dirname(file));
	if (!dirExists && !explicit) return `${label}: atlandı (${path.dirname(file)} yok)`;
	let existing = null;
	try {
		existing = fs.readFileSync(file, 'utf-8');
	} catch (e) {
		if (e.code !== 'ENOENT') return `${label}: atlandı (dosya okunamadı: ${e.message})`;
	}
	let merged;
	try {
		merged = mergeServerEntry(existing, entry);
	} catch (e) {
		return `${label}: atlandı. ${file}\n  ${e.message}`;
	}
	if (!merged.changed) return `${label}: zaten güncel (${file})`;
	if (dryRun) return `${label}: [deneme] ${file} dosyasına "${SERVER_NAME}" eklenecek${existing !== null ? ' (önce yedeği alınacak)' : ' (dosya oluşturulacak)'}`;
	let backupLine = '';
	if (existing !== null) {
		const bak = backupName(file, new Date());
		fs.copyFileSync(file, bak);
		backupLine = `\n  yedek: ${bak}`;
	} else {
		fs.mkdirSync(path.dirname(file), { recursive: true });
	}
	atomicWrite(file, merged.text);
	return `${label}: yazıldı (${file})${backupLine}`;
}

/** Quotes for cmd.exe, used only when a .cmd shim must go through a shell. */
function shellQuote(s) {
	return `"${String(s).replace(/"/g, '""')}"`;
}

function runClaude(claudePath, args) {
	if (/\.(cmd|bat)$/i.test(claudePath)) {
		const line = [claudePath, ...args].map(shellQuote).join(' ');
		return spawnSync(line, { shell: true, encoding: 'utf-8' });
	}
	return spawnSync(claudePath, args, { encoding: 'utf-8' });
}

function setupClaudeCode({ entry, dryRun }) {
	const label = CLIENT_LABEL['claude-code'];
	const { remove, add } = claudeCodeArgs(entry);
	const claudePath = findOnPath('claude');
	const manual = `claude ${add.map((a) => (/[\s"]/.test(a) ? shellQuote(a) : a)).join(' ')}`;
	if (!claudePath) return `${label}: atlandı (PATH'te "claude" yok). Elle çalıştır:\n  ${manual}`;
	if (dryRun) return `${label}: [deneme] şu komut çalıştırılacak:\n  ${manual}`;
	// Add first; only an "already exists" failure replaces the old entry, so a
	// failing add never leaves the user without their previous registration.
	let r = runClaude(claudePath, add);
	if (r.status !== 0 && /already exists/i.test(`${r.stdout ?? ''}${r.stderr ?? ''}`)) {
		const rm = runClaude(claudePath, remove);
		if (rm.status === 0) r = runClaude(claudePath, add);
	}
	if (r.status !== 0) {
		return `${label}: kayıt başarısız (çıkış ${r.status}${r.error ? `, ${r.error.message}` : ''}). Elle çalıştır:\n  ${manual}`;
	}
	return `${label}: kaydedildi (user kapsamı)`;
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === 'EPERM';
	}
}

function appRunning(dir) {
	try {
		const info = JSON.parse(fs.readFileSync(path.join(dir, 'mcp-endpoint.json'), 'utf-8'));
		return typeof info.pid === 'number' && pidAlive(info.pid);
	} catch {
		return false;
	}
}

function copyTree(src, dst) {
	const copied = [];
	for (const e of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, e.name);
		const d = path.join(dst, e.name);
		if (e.isDirectory()) {
			fs.mkdirSync(d, { recursive: true });
			copied.push(...copyTree(s, d));
		} else {
			fs.copyFileSync(s, d);
			copied.push(d);
		}
	}
	return copied;
}

function indexVault(id, dataDirAbs) {
	console.log('  Notlar indeksleniyor...');
	const r = spawnSync(process.execPath, ['--import', 'tsx', 'indexer/index-vault.ts', '--vault', id], {
		cwd: repoRoot,
		env: { ...process.env, DATA_DIR: dataDirAbs },
		stdio: 'inherit'
	});
	if (r.status === 0) return true;
	console.log(
		`  İndeksleme başarısız oldu (çıkış ${r.status ?? r.error?.message}). Gömme (embedding) sunucusuna erişilemiyor olabilir:\n` +
			`  Ollama'yı (ya da ayarladığın sağlayıcıyı) başlat ve şunu çalıştır:\n` +
			`    npm run index -- --vault ${id}\n` +
			`  ya da kasayı uygulamadan indeksle.`
	);
	return false;
}

async function setupSample({ dataDirAbs, dryRun }) {
	console.log(`\nÖrnek kasa ("${SAMPLE_NAME}")`);
	if (appRunning(dataDirAbs)) {
		console.log('  Atlandı: uygulama açık görünüyor (vaults.json uygulamaya ait). Uygulamayı kapatıp komutu yeniden çalıştır.');
		return;
	}
	if (dryRun) {
		let exists = false;
		try {
			const reg = JSON.parse(fs.readFileSync(path.join(dataDirAbs, 'vaults.json'), 'utf-8'));
			exists = (reg.vaults ?? []).some((v) => v.name === SAMPLE_NAME);
		} catch {
			// no registry yet
		}
		console.log(exists ? '  [deneme] Kasa zaten var; notlarına dokunulmaz, yalnız MCP\'ye açık olduğundan emin olunur.' : '  [deneme] Kasa oluşturulacak, MCP\'ye açılacak, notlar kopyalanıp indekslenecek.');
		return;
	}
	process.env.DATA_DIR = dataDirAbs;
	const { register } = await import('tsx/esm/api');
	register();
	const { createVault, setVaultMcpExposed, listVaults, contextFor } = await import('../src/lib/server/vaults.ts');
	const existing = listVaults().find((v) => v.name === SAMPLE_NAME);
	if (existing) {
		if (!existing.mcpExposed) setVaultMcpExposed(existing.id, true);
		console.log(`  Kasa zaten var (${existing.id}); notlarına dokunulmadı${existing.mcpExposed ? '' : ', MCP\'ye açıldı'}.`);
		return;
	}
	const record = createVault(SAMPLE_NAME);
	setVaultMcpExposed(record.id, true);
	const files = copyTree(sampleDir, contextFor(record).libraryRoot);
	console.log(`  Kasa oluşturuldu (${record.id}), MCP'ye açıldı, ${files.length} not kopyalandı.`);
	if (indexVault(record.id, dataDirAbs)) {
		console.log('  Hazır. İstemcinde şunu dene: "Örnek Kasa\'da zincir kuralını ara" ya da "Bayes teoremi notunu getir".');
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.cmd) {
		process.stdout.write(USAGE);
		return;
	}
	loadDotEnv();
	const { dir: dataDirAbs, source } = pickDataDir(args.dataDir);
	const entry = serverEntry({ nodePath: process.execPath, launchPath, dataDir: dataDirAbs });

	if (args.cmd === 'config') {
		process.stdout.write(`${configBlock(entry)}\n`);
		return;
	}
	if (args.cmd !== 'setup') throw new Error(`Bilinmeyen komut: ${args.cmd}\n\n${USAGE}`);

	if (args.client) {
		const bad = args.client.filter((c) => !ALL_CLIENTS.includes(c));
		if (bad.length) throw new Error(`Bilinmeyen istemci: ${bad.join(', ')} (geçerli: ${ALL_CLIENTS.join(', ')})`);
	}
	if (args.dryRun) console.log('Deneme modu: hiçbir şey yazılmayacak.\n');
	console.log(`Veri klasörü: ${dataDirAbs}\n  (kaynak: ${SOURCE_LABEL[source]})\n`);
	// Clients keep the absolute launch.mjs path: a git worktree is usually deleted later.
	if (/[\\/]\.claude[\\/]worktrees[\\/]/.test(launchPath)) {
		console.log(`UYARI: bu komut bir git worktree'den çalışıyor; istemciler ${launchPath} yolunu kaydedecek ve worktree silinince sunucu açılmaz. Ana klasörden çalıştır.\n`);
	}

	const paths = {
		desktop: claudeDesktopConfigPath({
			platform: process.platform,
			env: process.env,
			home: homeDir(),
			listDir: (d) => fs.readdirSync(d),
			exists: (p) => fs.existsSync(p)
		}),
		lmstudio: lmStudioConfigPath({ platform: process.platform, home: homeDir() })
	};
	const explicit = Boolean(args.client);
	const clients = args.client ?? detectClients(paths);
	if (clients.length === 0) console.log('Hiçbir MCP istemcisi bulunamadı; aşağıdaki bloğu istemcine elle ekleyebilirsin.');

	console.log('İstemciler');
	for (const c of clients) {
		let line;
		if (c === 'claude-desktop') line = writeJsonClient({ label: CLIENT_LABEL[c], file: paths.desktop, entry, explicit, dryRun: args.dryRun });
		else if (c === 'lm-studio') line = writeJsonClient({ label: CLIENT_LABEL[c], file: paths.lmstudio, entry, explicit, dryRun: args.dryRun });
		else line = setupClaudeCode({ entry, dryRun: args.dryRun });
		console.log(`  ${line}`);
	}
	if (clients.includes('claude-desktop') && !args.dryRun) console.log('\nClaude Desktop açıksa tamamen kapatıp yeniden başlat.');

	if (!args.noSample) await setupSample({ dataDirAbs, dryRun: args.dryRun });

	console.log(`\nDiğer istemciler (Jan vb.) için yapılandırma bloğu:\n${configBlock(entry)}`);
}

main().catch((e) => {
	console.error(`Hata: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
});
