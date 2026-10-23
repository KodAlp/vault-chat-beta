// Tek komutla uygulama sürümünü tüm dosyalarda günceller:
//   node scripts/bump-version.mjs 0.3.1        (ya da: patch | minor | major)
// Dosyalar metin olarak düzenlenir (yeniden serileştirme yok) — girinti ve
// sondaki satır sonu aynen korunur. Dosyalar mevcut sürümde anlaşamıyorsa
// hiçbir şey yazmadan çıkar.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.VC_RELEASE_ROOT
	? path.resolve(process.env.VC_RELEASE_ROOT)
	: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(root, p);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const arg = process.argv[2];
if (!arg) {
	console.error('Kullanım: node scripts/bump-version.mjs <x.y.z | patch | minor | major>');
	process.exit(1);
}

const read = (p) => readFileSync(rel(p), 'utf8');

// Her hedef: dosya, güncel sürümü okuyan ve yeni sürümle değiştiren işlev.
// Değiştirme, ilk eşleşmeyi hedef alır; eşleşme yoksa hata verir.
function sub(text, re, replacement, label) {
	if (!re.test(text)) throw new Error(`${label}: sürüm satırı bulunamadı`);
	return text.replace(re, replacement);
}

const targets = [];
function add(file, getCurrent, apply) {
	if (!existsSync(rel(file))) return;
	targets.push({ file, text: read(file), getCurrent, apply });
}

// package.json — üst düzey "version" (girintisiz ilk eşleşme: 2 boşluk ya da tab)
const topVersion = /^(\s*"version"\s*:\s*")([^"]+)(")/m;
add('package.json', (t) => [t.match(topVersion)?.[2]], (t, v) => sub(t, topVersion, `$1${v}$3`, 'package.json'));

// package-lock.json — üst düzey version + packages[""].version
add(
	'package-lock.json',
	(t) => {
		const j = JSON.parse(t);
		return [j.version, j.packages?.['']?.version];
	},
	(t, v) => {
		// 1) üst düzey "version" (dosyadaki ilk eşleşme), 2) packages[""] bloğundaki ilk "version"
		let out = sub(t, topVersion, `$1${v}$3`, 'package-lock.json (üst düzey)');
		const pk = /("packages"\s*:\s*\{\s*""\s*:\s*\{[\s\S]*?"version"\s*:\s*")([^"]+)(")/;
		out = sub(out, pk, `$1${v}$3`, 'package-lock.json (packages[""])');
		return out;
	}
);

// tauri.conf.json — üst düzey "version"
add('src-tauri/tauri.conf.json', (t) => [JSON.parse(t).version], (t, v) => sub(t, topVersion, `$1${v}$3`, 'tauri.conf.json'));

// Cargo.toml — yalnız [package] tablosundaki version
const cargoPkg = /(\[package\][^[]*?^version\s*=\s*")([^"]+)(")/m;
add('src-tauri/Cargo.toml', (t) => [t.match(cargoPkg)?.[2]], (t, v) => sub(t, cargoPkg, `$1${v}$3`, 'Cargo.toml'));

// Cargo.lock — uygulamanın kendi paketi (Cargo.toml'daki name)
const cargoName = (existsSync(rel('src-tauri/Cargo.toml')) ? read('src-tauri/Cargo.toml') : '').match(/\[package\][^[]*?^name\s*=\s*"([^"]+)"/m)?.[1];
if (cargoName) {
	const lockRe = new RegExp(String.raw`(\[\[package\]\]\r?\nname = "${cargoName}"\r?\nversion = ")([^"]+)(")`);
	add('src-tauri/Cargo.lock', (t) => [t.match(lockRe)?.[2]], (t, v) => sub(t, lockRe, `$1${v}$3`, 'Cargo.lock'));
}

// Yan etki: docs/macos-deneme-listesi.md içindeki `vault-chat_<sürüm>_` dosya adı örneği
const docRe = /(vault-chat_)(\d+\.\d+\.\d+[^_\s]*)(_)/g;

// Güncel sürümler uyuşuyor mu?
const currents = targets.map((t) => ({ file: t.file, values: t.getCurrent(t.text) }));
const all = new Set(currents.flatMap((c) => c.values));
if (all.size !== 1 || all.has(undefined)) {
	console.error('Dosyalar güncel sürümde anlaşmıyor, hiçbir şey yazılmadı:');
	for (const c of currents) console.error(`  ${c.file}: ${c.values.join(', ')}`);
	process.exit(1);
}
const current = [...all][0];

let next = arg;
if (['patch', 'minor', 'major'].includes(arg)) {
	const m = current.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!m) {
		console.error(`Güncel sürüm (${current}) ayrıştırılamadı.`);
		process.exit(1);
	}
	let [maj, min, pat] = m.slice(1).map(Number);
	if (arg === 'major') [maj, min, pat] = [maj + 1, 0, 0];
	else if (arg === 'minor') [min, pat] = [min + 1, 0];
	else pat += 1;
	next = `${maj}.${min}.${pat}`;
} else if (!SEMVER.test(arg)) {
	console.error(`Geçersiz sürüm: "${arg}" (x.y.z, patch, minor ya da major bekleniyor)`);
	process.exit(1);
}

if (next === current) {
	console.log(`Sürüm zaten ${current}; değişiklik yok.`);
	process.exit(0);
}

// Önce hepsini bellekte hesapla; biri patlarsa hiçbir dosya yazılmaz.
const results = targets.map((t) => ({ file: t.file, out: t.apply(t.text, next) }));
const docFile = 'docs/macos-deneme-listesi.md';
if (existsSync(rel(docFile))) {
	const text = read(docFile);
	if (docRe.test(text)) results.push({ file: docFile, out: text.replace(docRe, `$1${next}$3`) });
	docRe.lastIndex = 0;
}
for (const r of results) writeFileSync(rel(r.file), r.out);

console.log(`Sürüm ${current} -> ${next}`);
for (const r of results) console.log(`  güncellendi: ${r.file}`);
console.log('Sonraki: git diff ile kontrol et, sonra commit.');
