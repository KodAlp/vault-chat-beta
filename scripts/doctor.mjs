// "Am I ready to run this?" preflight — one command, plain `node` (no tsx),
// so it works even before `npm install` has fully succeeded. Every check
// that could drift from the actual code (which models are required, where
// providers.json lives) reads the config directly instead of hardcoding a
// duplicate value. No provider is required on its own (Aşama 4d): only the
// chat chain's head and the embedding provider are checked, and an unreachable
// local server that is neither is not a failure.
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

/** Per-platform answer to "what do I install so a native module can compile". */
function nativeBuildToolsHint() {
	if (process.platform === 'win32') return 'Visual Studio Build Tools (C++ workload).';
	if (process.platform === 'darwin') return 'Xcode komut satırı araçları ("xcode-select --install").';
	return 'build-essential (g++, make) ve python3 paketleri (dağıtımının paket yöneticisiyle).';
}

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
			'npm install çalıştırın; internet erişimi prebuild-install\'ın hazır binary indirmesi için gerekli. Yine de başarısız olursa derleme araçları + Python 3 kurulu olmalı: ' + nativeBuildToolsHint()
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
let providersConfig = null;
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
			providersConfig = JSON.parse(raw);
			ok(`data/providers.json okunabiliyor (${providersPath})`);
		} catch (err) {
			fail(`data/providers.json geçersiz JSON: ${err instanceof Error ? err.message : err}`);
		}
	}
}

// --- Sağlayıcılar -------------------------------------------------------------
// Hiçbir sağlayıcı tek başına zorunlu değil: yalnızca sohbet zincirinin başındaki sağlayıcı ve (varsa)
// embedding sağlayıcısı gerçekten kullanılır, yalnızca onların erişilebilirliği hata sayılır. Zincirde
// olmayan bir Ollama (ya da başka bir yerel sunucu) çalışmıyorsa bu bir sorun değildir.
console.log('\nSağlayıcılar');
if (providersConfig) {
	const providers = providersConfig.providers ?? [];
	const byId = new Map(providers.map((p) => [p.id, p]));
	const isLocal = (p) => p.kind === 'ollama' || p.local === true;

	/** Yerel bir sağlayıcıya ulaşılabiliyor mu; Ollama ise kurulu model adlarını da döndürür. */
	async function probeLocal(p) {
		const base = String(p.baseUrl).replace(/\/+$/, '');
		const url = p.kind === 'ollama' ? `${base}/api/tags` : `${base}/models`;
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			const names = p.kind === 'ollama' ? (data.models ?? []).map((m) => m.name) : (data.data ?? []).map((m) => m.id);
			return { reachable: true, names, error: null };
		} catch (err) {
			return { reachable: false, names: [], error: err instanceof Error ? err.message : String(err) };
		}
	}

	function modelInstalled(installed, wanted) {
		const [wantedBase, wantedTag] = wanted.split(':');
		return installed.some((name) => {
			const [base, tag] = name.split(':');
			if (base !== wantedBase) return false;
			return wantedTag === undefined || tag === wantedTag;
		});
	}

	function startHint(p) {
		return p.kind === 'ollama'
			? '"ollama serve" çalıştırın (veya Ollama uygulamasını başlatın) — https://ollama.com'
			: `${p.label ?? p.id} sunucusunu başlatın`;
	}

	// Sohbet: zincirin başındaki etkin sağlayıcı
	const chatHeadId = (providersConfig.chains?.chat ?? []).find((id) => byId.get(id)?.enabled);
	const chatHead = chatHeadId ? byId.get(chatHeadId) : null;
	if (!chatHead) {
		warn('Sohbet zinciri boş — kurulum tamamlanmamış, sohbet henüz yanıt veremez', 'Uygulamayı açıp kurulum sihirbazını çalıştırın (/setup/local-server) ya da Ayarlar > Sağlayıcılar\'dan bir sağlayıcı ekleyin.');
	} else if (!isLocal(chatHead)) {
		ok(`Sohbet sağlayıcısı: ${chatHead.label ?? chatHead.id} (bulut — erişilebilirlik burada kontrol edilmez)`);
	} else {
		const probe = await probeLocal(chatHead);
		if (!probe.reachable) {
			fail(`Sohbet sağlayıcısına ulaşılamadı: ${chatHead.label ?? chatHead.id} (${chatHead.baseUrl}): ${probe.error}`, startHint(chatHead));
		} else {
			ok(`Sohbet sağlayıcısı çalışıyor: ${chatHead.label ?? chatHead.id} (${chatHead.baseUrl})`);
			// Kurulu model listesi yalnızca Ollama'da adıyla karşılaştırılabilir (varsayılan model etiketli).
			if (chatHead.kind === 'ollama' && chatHead.defaultModel) {
				if (modelInstalled(probe.names, chatHead.defaultModel)) ok(`Sohbet modeli çekili: ${chatHead.defaultModel}`);
				else fail(`Sohbet modeli çekili değil: ${chatHead.defaultModel}`, `ollama pull ${chatHead.defaultModel}`);
			}
		}
	}

	// Embedding: açık bir blok, ya da (blok hiç yoksa) bir ollama girdisi varsa eski varsayılan; aksi halde
	// "yalnızca anahtar kelime araması" (null).
	const hasEmbeddingKey = Object.prototype.hasOwnProperty.call(providersConfig, 'embedding');
	const embedding = providersConfig.embedding;
	if (embedding === null || (!hasEmbeddingKey && !byId.has('ollama'))) {
		ok('Embedding: yok — yalnızca anahtar kelime araması (bilgi)');
	} else {
		const embedProvider = embedding ? byId.get(embedding.providerId) : byId.get('ollama');
		const modelLabel = embedding ? embedding.model : 'Ollama varsayılan gömme modeli (ayar yok)';
		if (!embedProvider) {
			fail(`Embedding sağlayıcısı providers.json'da yok: ${embedding?.providerId}`, 'Ayarlar > Sağlayıcılar\'dan başka bir embedding sağlayıcısı seçin ya da yalnızca anahtar kelime aramasına geçin.');
		} else if (!isLocal(embedProvider)) {
			ok(`Embedding: ${embedProvider.label ?? embedProvider.id} / ${modelLabel} (bulut — erişilebilirlik burada kontrol edilmez)`);
		} else {
			const probe = await probeLocal(embedProvider);
			if (!probe.reachable) {
				fail(`Embedding sağlayıcısına ulaşılamadı: ${embedProvider.label ?? embedProvider.id} (${embedProvider.baseUrl}): ${probe.error}`, startHint(embedProvider));
			} else {
				ok(`Embedding sağlayıcısı çalışıyor: ${embedProvider.label ?? embedProvider.id} / ${modelLabel}`);
				if (embedding && embedProvider.kind === 'ollama') {
					if (modelInstalled(probe.names, embedding.model)) ok(`Embedding modeli çekili: ${embedding.model}`);
					else fail(`Embedding modeli çekili değil: ${embedding.model}`, `ollama pull ${embedding.model}`);
				}
			}
		}
	}

	// Zincirde / embedding'de olmayan yerel sağlayıcılar: yalnızca bilgi
	const used = new Set([chatHead?.id, embedding ? embedding.providerId : (hasEmbeddingKey ? null : 'ollama')]);
	for (const p of providers.filter((x) => x.enabled && isLocal(x) && !used.has(x.id))) {
		const probe = await probeLocal(p);
		ok(`${p.label ?? p.id}: ${probe.reachable ? 'çalışıyor' : 'çalışmıyor'} (kullanılmıyor — sorun değil)`);
	}
}

// --- Opsiyonel: içe aktarma araçları ----------------------------------------
console.log('\nOpsiyonel (belge/YouTube içe aktarma için)');
{
	// src/lib/server/python-bin.ts ile aynı mantık (bağımsız .mjs olduğu için
	// kopya — ikisini birlikte güncelleyin). Sıra: PYTHON_BIN, uygulamanın kendi
	// venv'i, PATH taraması, bilinen konumlar. Windows'ta WindowsApps alias'ı atlanır.
	const isWin = process.platform === 'win32';
	const isMac = process.platform === 'darwin';
	const dataRoot = path.resolve(root, nonEmpty(process.env.DATA_DIR) ?? 'data');

	function pythonCandidates() {
		const out = [];
		const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
		if (isWin) {
			for (const dir of pathDirs) {
				if (dir.toLowerCase().includes('windowsapps')) continue;
				const exe = path.join(dir, 'python.exe');
				if (existsSync(exe)) out.push(exe);
			}
			const programsDir = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python');
			if (existsSync(programsDir)) {
				const versions = readdirSync(programsDir)
					.filter((d) => /^Python3\d+$/.test(d))
					.sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)));
				for (const v of versions) {
					const exe = path.join(programsDir, v, 'python.exe');
					if (existsSync(exe)) out.push(exe);
				}
			}
			return out;
		}
		// macOS: /usr/bin/python3 is a shim that opens an "install developer
		// tools" dialog when CLT is missing — skip it unless CLT/Xcode exists.
		const devTools = !isMac || existsSync('/Library/Developer/CommandLineTools/usr/bin/python3') || existsSync('/Applications/Xcode.app/Contents/Developer');
		const push = (exe) => {
			if (isMac && exe === '/usr/bin/python3' && !devTools) return;
			if (!out.includes(exe)) out.push(exe);
		};
		for (const dir of pathDirs) {
			const exe = path.posix.join(dir, 'python3');
			if (existsSync(exe)) push(exe);
		}
		const known = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'];
		if (isMac) known.push('/Library/Frameworks/Python.framework/Versions/Current/bin/python3');
		known.push('/usr/bin/python3');
		for (const exe of known) if (existsSync(exe)) push(exe);
		return out;
	}

	function resolvePython() {
		if (nonEmpty(process.env.PYTHON_BIN)) return process.env.PYTHON_BIN;
		const venvPy = isWin
			? path.join(dataRoot, 'python-venv', 'Scripts', 'python.exe')
			: path.join(dataRoot, 'python-venv', 'bin', 'python3');
		if (existsSync(venvPy)) return venvPy;
		return pythonCandidates()[0] ?? null;
	}

	function resolvePandoc() {
		if (nonEmpty(process.env.PANDOC_BIN) && existsSync(process.env.PANDOC_BIN)) return process.env.PANDOC_BIN;
		const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
		if (isWin) {
			for (const dir of pathDirs) {
				if (dir.toLowerCase().includes('windowsapps')) continue;
				const exe = path.join(dir, 'pandoc.exe');
				if (existsSync(exe)) return exe;
			}
			for (const base of [process.env.LOCALAPPDATA, process.env.ProgramFiles]) {
				if (!base) continue;
				const exe = path.join(base, 'Pandoc', 'pandoc.exe');
				if (existsSync(exe)) return exe;
			}
			return null;
		}
		for (const dir of pathDirs) {
			const exe = path.posix.join(dir, 'pandoc');
			if (existsSync(exe)) return exe;
		}
		for (const exe of ['/opt/homebrew/bin/pandoc', '/usr/local/bin/pandoc', '/usr/bin/pandoc']) {
			if (existsSync(exe)) return exe;
		}
		return null;
	}

	const installHint = isWin
		? "python.org'dan Python 3.10+ kurun (Microsoft Store sürümü değil), veya PYTHON_BIN ortam değişkenini ayarlayın."
		: isMac
			? "brew install python@3.12 (veya python.org), ya da PYTHON_BIN ortam değişkenini ayarlayın."
			: "Dağıtımın paket yöneticisiyle kurun, örn. sudo apt install python3 python3-venv; veya PYTHON_BIN ayarlayın.";

	const pythonBin = resolvePython();
	if (!pythonBin) {
		warn('Python bulunamadı — PDF/doküman/YouTube içe aktarma çalışmaz', installHint);
	} else {
		const versionCheck = spawnSync(pythonBin, ['--version'], { encoding: 'utf-8', timeout: 5000 });
		if (versionCheck.error || versionCheck.status !== 0) {
			warn(`Python çalıştırılamadı (${pythonBin})`, installHint);
		} else {
			const versionText = versionCheck.stdout.trim() || versionCheck.stderr.trim();
			const m = /Python\s+(\d+)\.(\d+)/i.exec(versionText);
			if (m && (Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 10))) {
				warn(`Python çok eski: ${versionText} (${pythonBin}) — 3.10 veya yenisi gerekir`, installHint);
			} else {
				ok(`Python bulundu: ${versionText} (${pythonBin})`);
				for (const pkg of ['markitdown', 'yt_dlp']) {
					const check = spawnSync(pythonBin, ['-c', `import ${pkg}`], { encoding: 'utf-8', timeout: 30000 });
					if (check.status === 0) ok(`Python paketi kurulu: ${pkg}`);
					else warn(`Python paketi kurulu değil: ${pkg}`, 'Uygulamadaki "Şimdi kur" düğmesi (POSIX için uygulamanın kendi venv klasörüne kurar) veya pip install -r ingest/requirements.txt');
				}
			}
		}
	}

	const pandocPath = resolvePandoc();
	if (pandocPath) ok(`pandoc bulundu (.tex dönüştürme için): ${pandocPath}`);
	else warn('pandoc bulunamadı — yalnızca .tex dosyası içe aktarımını etkiler', "pandoc.org'dan kurun (pip değil, sistem paketi; macOS: brew install pandoc)");
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
