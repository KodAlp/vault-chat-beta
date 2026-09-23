// "Am I ready to run this?" preflight — one command, plain `node` (no tsx),
// so it works even before `npm install` has fully succeeded. Every check
// that could drift from the actual code (required models, providers.json
// location) reads that code/config directly instead of hardcoding a
// duplicate value — see the embed-model regex-extraction below for why:
// KURULUM-REHBERI.md itself drifted from embed-config.ts's real EMBED_MODEL
// once already (nomic-embed-text vs bge-m3), and this check exists so that
// class of bug is caught by a command instead of by a user's failed
// `npm run index`.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

try {
	process.loadEnvFile();
} catch {
	// .env is optional — same bridge vite.config.ts uses
}

const root = process.cwd();
let failures = 0;
let warnings = 0;

function ok(label) {
	console.log(`  OK   ${label}`);
}
function fail(label, fix) {
	failures++;
	console.log(`  HATA ${label}`);
	if (fix) console.log(`       -> ${fix}`);
}
function warn(label, fix) {
	warnings++;
	console.log(`  UYARI ${label}`);
	if (fix) console.log(`        -> ${fix}`);
}

function nonEmpty(v) {
	return v && v.length > 0 ? v : undefined;
}

// --- Node sürümü -----------------------------------------------------------
console.log('Node / platform');
{
	const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
	const range = pkg.engines?.node ?? '';
	const [major] = process.versions.node.split('.').map(Number);
	// package.json pins ">=22 <23" today — parsed loosely (min/max majors)
	// rather than pulling in a semver dependency for one check.
	const bounds = [...range.matchAll(/(>=|<)\s*(\d+)/g)].map(([, op, n]) => [op, Number(n)]);
	const minOk = bounds.every(([op, n]) => (op === '>=' ? major >= n : true));
	const maxOk = bounds.every(([op, n]) => (op === '<' ? major < n : true));
	if (minOk && maxOk) {
		ok(`Node ${process.versions.node} (gerekli: ${range || 'belirtilmemiş'})`);
	} else {
		fail(
			`Node ${process.versions.node} — package.json "engines" (${range}) ile uyuşmuyor`,
			'Node 22.x kurun (https://nodejs.org) — better-sqlite3 native binary\'si bu sürüme derli, farklı bir sürüm çalışma anında ABI hatası verir.'
		);
	}

	if (process.platform === 'win32' && process.arch === 'arm64') {
		fail(
			'ARM64 Windows tespit edildi',
			'sqlite-vec\'in Windows için yalnızca win32-x64 prebuilt paketi var — ARM64 desteklenmiyor.'
		);
	} else {
		ok(`Platform ${process.platform}/${process.arch}`);
	}
}

// --- Native modüller ---------------------------------------------------------
console.log('\nNative modüller');
{
	try {
		const { default: Database } = await import('better-sqlite3');
		const db = new Database(':memory:');
		db.exec('SELECT 1');
		db.close();
		ok('better-sqlite3 yükleniyor ve çalışıyor');
	} catch (err) {
		fail(
			`better-sqlite3 yüklenemedi: ${err instanceof Error ? err.message : err}`,
			'npm install çalıştırın; internet erişimi prebuild-install\'ın hazır binary indirmesi için gerekli. Yine de başarısız olursa Visual Studio Build Tools (C++ workload) + Python 3 kurulu olmalı.'
		);
	}

	try {
		const { default: Database } = await import('better-sqlite3');
		const sqliteVec = await import('sqlite-vec');
		const db = new Database(':memory:');
		sqliteVec.load(db);
		db.exec('CREATE VIRTUAL TABLE t USING vec0(embedding FLOAT[4])');
		db.close();
		ok('sqlite-vec yükleniyor ve çalışıyor');
	} catch (err) {
		fail(
			`sqlite-vec yüklenemedi: ${err instanceof Error ? err.message : err}`,
			'npm install çalıştırın. ARM64 Windows\'ta bu paketin prebuilt binary\'si yok (bkz. yukarısı).'
		);
	}
}

// --- providers.json ----------------------------------------------------------
console.log('\nYapılandırma');
let requiredChatModel = null;
let ollamaUrl = nonEmpty(process.env.OLLAMA_URL) ?? 'http://127.0.0.1:11434';
{
	const dataDir = path.resolve(root, nonEmpty(process.env.DATA_DIR) ?? 'data');
	const providersPath = nonEmpty(process.env.PROVIDERS_PATH) ?? path.join(dataDir, 'providers.json');
	if (!existsSync(providersPath)) {
		fail(`data/providers.json bulunamadı (${providersPath})`, 'Bu dosya repo ile gelir — git clone/pull ile geldiğinden emin olun, ya da DATA_DIR farklı bir yeri gösteriyorsa oraya elle kopyalayın.');
	} else {
		try {
			// Strip a leading UTF-8 BOM (U+FEFF) — Notepad and PowerShell's
			// Set-Content both write one by default on Windows, and
			// JSON.parse rejects it. charCodeAt check, not a regex literal,
			// so the BOM codepoint is never an invisible character sitting
			// in this source file.
			let raw = readFileSync(providersPath, 'utf-8');
			if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
			const parsed = JSON.parse(raw);
			const ollamaEntry = parsed.providers?.find((p) => p.id === 'ollama');
			requiredChatModel = ollamaEntry?.defaultModel ?? null;
			ok(`data/providers.json okunabiliyor (${providersPath})`);
		} catch (err) {
			fail(`data/providers.json geçersiz JSON: ${err instanceof Error ? err.message : err}`);
		}
	}
}

// EMBED_MODEL'i embed-config.ts'in KENDİSİNDEN oku (regex ile) — bu değeri
// burada tekrar hardcode etmek, KURULUM-REHBERI.md'nin bir kez düştüğü aynı
// hataya (kodla dokümanın ayrışması) doctor.mjs'i de düşürür.
let requiredEmbedModel = null;
{
	const embedConfigPath = path.join(root, 'src', 'lib', 'server', 'embed-config.ts');
	try {
		const text = readFileSync(embedConfigPath, 'utf-8');
		const match = text.match(/export const EMBED_MODEL\s*=\s*'([^']+)'/);
		if (match) {
			requiredEmbedModel = match[1];
		} else {
			warn(`EMBED_MODEL, ${embedConfigPath} içinde bulunamadı (dosya formatı değişmiş olabilir)`);
		}
	} catch {
		warn(`${embedConfigPath} okunamadı — embedding modeli kontrolü atlanıyor`);
	}
}

// --- Ollama --------------------------------------------------------------
console.log('\nOllama');
{
	let installed = [];
	try {
		const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		installed = (data.models ?? []).map((m) => m.name);
		ok(`Ollama çalışıyor (${ollamaUrl})`);
	} catch (err) {
		fail(
			`Ollama'ya ulaşılamadı (${ollamaUrl}): ${err instanceof Error ? err.message : err}`,
			'"ollama serve" çalıştırın (veya Ollama uygulamasını başlatın) — https://ollama.com'
		);
	}

	function modelInstalled(wanted) {
		const [wantedBase, wantedTag] = wanted.split(':');
		return installed.some((name) => {
			const [base, tag] = name.split(':');
			if (base !== wantedBase) return false;
			return wantedTag === undefined || tag === wantedTag;
		});
	}

	if (installed.length > 0) {
		if (requiredChatModel) {
			if (modelInstalled(requiredChatModel)) ok(`Sohbet modeli çekili: ${requiredChatModel}`);
			else fail(`Sohbet modeli çekili değil: ${requiredChatModel}`, `ollama pull ${requiredChatModel}`);
		}
		if (requiredEmbedModel) {
			if (modelInstalled(requiredEmbedModel)) ok(`Embedding modeli çekili: ${requiredEmbedModel}`);
			else fail(`Embedding modeli çekili değil: ${requiredEmbedModel}`, `ollama pull ${requiredEmbedModel}`);
		}
	}
}

// --- Opsiyonel: içe aktarma araçları ----------------------------------------
console.log('\nOpsiyonel (belge/YouTube içe aktarma için)');
{
	// convertQueue.ts'teki resolvePythonBin ile aynı mantık, kısaltılmış:
	// WindowsApps App Execution Alias'ını atla (STATUS_DLL_INIT_FAILED riski),
	// PATH'i doğrudan tara.
	function resolvePython() {
		if (nonEmpty(process.env.PYTHON_BIN)) return process.env.PYTHON_BIN;
		if (process.platform !== 'win32') return 'python3';
		const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
		for (const dir of pathDirs) {
			if (dir.toLowerCase().includes('windowsapps')) continue;
			const exe = path.join(dir, 'python.exe');
			if (existsSync(exe)) return exe;
		}
		const programsDir = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python');
		if (existsSync(programsDir)) {
			const versions = readdirSync(programsDir)
				.filter((d) => /^Python3\d+$/.test(d))
				.sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)));
			for (const v of versions) {
				const exe = path.join(programsDir, v, 'python.exe');
				if (existsSync(exe)) return exe;
			}
		}
		return null;
	}

	const pythonBin = resolvePython();
	if (!pythonBin) {
		warn('Python bulunamadı — PDF/doküman/YouTube içe aktarma çalışmaz', 'python.org\'dan Python 3 kurun (Microsoft Store sürümü değil), veya PYTHON_BIN ortam değişkenini ayarlayın.');
	} else {
		const versionCheck = spawnSync(pythonBin, ['--version'], { encoding: 'utf-8' });
		if (versionCheck.error || versionCheck.status !== 0) {
			warn(`Python çalıştırılamadı (${pythonBin})`, 'python.org\'dan Python 3 kurun.');
		} else {
			ok(`Python bulundu: ${versionCheck.stdout.trim() || versionCheck.stderr.trim()} (${pythonBin})`);
			for (const pkg of ['markitdown', 'yt_dlp']) {
				const check = spawnSync(pythonBin, ['-c', `import ${pkg}`], { encoding: 'utf-8' });
				if (check.status === 0) ok(`Python paketi kurulu: ${pkg}`);
				else warn(`Python paketi kurulu değil: ${pkg}`, 'pip install -r ingest/requirements.txt');
			}
		}
	}

	const pandocCheck = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pandoc'], { encoding: 'utf-8' });
	if (pandocCheck.status === 0) ok('pandoc bulundu (.tex dönüştürme için)');
	else warn('pandoc bulunamadı — yalnızca .tex dosyası içe aktarımını etkiler', 'pandoc.org\'dan kurun (pip değil, sistem paketi)');
}

// --- Özet ------------------------------------------------------------------
console.log('\n---');
if (failures > 0) {
	console.log(`${failures} hata, ${warnings} uyarı — uygulama şu an düzgün çalışmaz.`);
	process.exit(1);
} else if (warnings > 0) {
	console.log(`0 hata, ${warnings} uyarı — temel işlevler çalışır, opsiyonel özellikler eksik olabilir.`);
	process.exit(0);
} else {
	console.log('Her şey hazır.');
	process.exit(0);
}
