// Conventional Commits'ten otomatik sürüm yükseltme:
//   node scripts/release.mjs             son v* etiketinden beri commitlere bakar, sürümü yükseltir,
//                                        "chore(release): vX.Y.Z" commit'i ve vX.Y.Z etiketi oluşturur
//   node scripts/release.mjs --dry-run   yalnız ne olacağını yazar, hiçbir şeyi değiştirmez
//   node scripts/release.mjs --auto      derleme öncesi sessiz mod: koşullar uymuyorsa uyarıp 0 ile çıkar
// Sürüm dosyalarını scripts/bump-version.mjs yazar; burada mantık tekrarlanmaz.
// Test için kök dizin VC_RELEASE_ROOT ortam değişkeniyle değiştirilebilir.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __file = fileURLToPath(import.meta.url);
const root = process.env.VC_RELEASE_ROOT
	? path.resolve(process.env.VC_RELEASE_ROOT)
	: path.resolve(path.dirname(__file), '..');

// bump-version.mjs'in dokunduğu dosyalar
const VERSION_FILES = [
	'package.json',
	'package-lock.json',
	'src-tauri/tauri.conf.json',
	'src-tauri/Cargo.toml',
	'src-tauri/Cargo.lock',
	'docs/macos-deneme-listesi.md'
];

const LEVELS = { patch: 1, minor: 2, major: 3 };
const PATCH_TYPES = new Set(['fix', 'perf', 'refactor', 'revert', 'build']);
const HEADER = /^(\w+)(\([^)]*\))?(!)?:\s/;

// Tek bir commit'in düzeyi: 'major' | 'minor' | 'patch' | null
function levelOf({ subject = '', body = '' }) {
	if (/^BREAKING[ -]CHANGE:/m.test(body)) return 'major';
	if (subject.startsWith('Merge ')) return null;
	const m = subject.match(HEADER);
	if (!m) return null;
	if (m[3]) return 'major';
	const type = m[1].toLowerCase();
	if (type === 'feat') return 'minor';
	if (PATCH_TYPES.has(type)) return 'patch';
	return null;
}

// commits = [{subject, body}] → en yüksek düzey ya da null
export function decideBump(commits) {
	let best = null;
	for (const c of commits) {
		const l = levelOf(c);
		if (l && (!best || LEVELS[l] > LEVELS[best])) best = l;
	}
	return best;
}

export function nextVersion(current, level) {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
	if (!m) throw new Error(`Sürüm x.y.z biçiminde olmalı: "${current}"`);
	let [maj, min, pat] = m.slice(1).map(Number);
	if (level === 'major') [maj, min, pat] = [maj + 1, 0, 0];
	else if (level === 'minor') [min, pat] = [min + 1, 0];
	else if (level === 'patch') pat += 1;
	else throw new Error(`Bilinmeyen düzey: "${level}"`);
	return `${maj}.${min}.${pat}`;
}

function git(...args) {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main() {
	const argv = process.argv.slice(2);
	const auto = argv.includes('--auto');
	const dry = argv.includes('--dry-run');

	// Koşul sağlanmadığında: --auto ise uyarı + 0, değilse hata + 1
	const stop = (msg) => {
		if (auto) {
			console.warn(`Uyarı: ${msg}`);
			process.exit(0);
		}
		console.error(`Hata: ${msg}`);
		process.exit(1);
	};

	let tag;
	try {
		tag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*').trim();
	} catch {
		stop(
			"HEAD'den erişilebilen bir sürüm etiketi (v*) yok. Başlangıç noktası için bir etiket oluştur:\n" +
				'  git tag -a v0.1.0 -m v0.1.0'
		);
	}

	const raw = git('log', `${tag}..HEAD`, '--format=%s%x1f%b%x1e');
	const commits = raw
		.split('\x1e')
		.map((r) => r.replace(/^\s+/, ''))
		.filter(Boolean)
		.map((r) => {
			const [subject, body = ''] = r.split('\x1f');
			return { subject: subject.trim(), body };
		})
		.filter((c) => !c.subject.startsWith('chore(release):'));

	const level = decideBump(commits);
	if (!level) {
		console.log(`${tag} etiketinden beri sürümü etkileyen commit yok; sürüm yükseltilmedi.`);
		process.exit(0);
	}

	const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
	if (branch !== 'main' && !dry) {
		stop(`Sürüm yalnız main dalında yükseltilir; "${branch}" dalında sürüm yükseltilmedi.`);
	}

	const existing = VERSION_FILES.filter((f) => existsSync(path.join(root, f)));
	const dirty = git('status', '--porcelain', '--', ...existing).trim();
	if (dirty) {
		stop(`Sürüm dosyalarında commitlenmemiş değişiklik var, önce commitle ya da geri al:\n${dirty}`);
	}

	const current = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
	if (tag !== `v${current}`) {
		stop(`package.json sürümü (${current}) son etiketle (${tag}) uyuşmuyor.`);
	}

	const next = nextVersion(current, level);

	const relevant = commits.filter((c) => levelOf(c));
	if (dry) {
		console.log(`Son etiket: ${tag}`);
		for (const l of ['major', 'minor', 'patch']) {
			const list = relevant.filter((c) => levelOf(c) === l);
			if (!list.length) continue;
			console.log(`${l}:`);
			for (const c of list) console.log(`  - ${c.subject}`);
		}
		console.log(`Sürüm: ${current} -> ${next} (${level})  [dry-run, hiçbir şey değişmedi]`);
		return;
	}

	const bump = spawnSync(process.execPath, [path.join(path.dirname(__file), 'bump-version.mjs'), next], {
		cwd: root,
		stdio: 'inherit',
		env: { ...process.env, VC_RELEASE_ROOT: root }
	});
	if (bump.status !== 0) {
		console.error('bump-version.mjs başarısız oldu; commit ve etiket oluşturulmadı.');
		process.exit(bump.status ?? 1);
	}

	// Yalnız git'in izlediği sürüm dosyaları (pathspec commit: başka kirli dosyalar dahil olmaz)
	const tracked = git('ls-files', '--', ...existing).split('\n').filter(Boolean);
	const bullets = relevant.map((c) => `- ${c.subject}`).join('\n');
	git('commit', '-m', `chore(release): v${next}`, '-m', bullets, '--', ...tracked);
	git('tag', '-a', `v${next}`, '-m', `v${next}`);

	console.log(`\nSürüm v${next} commitlendi ve etiketlendi.`);
	console.log('Göndermek için: git push --follow-tags');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __file) main();
