import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideBump, nextVersion } from './release.mjs';

const c = (subject, body = '') => ({ subject, body });

test('decideBump: türlere göre düzey', () => {
	assert.equal(decideBump([c('feat: yeni')]), 'minor');
	assert.equal(decideBump([c('feat(ui): yeni')]), 'minor');
	for (const t of ['fix', 'perf', 'refactor', 'revert', 'build']) {
		assert.equal(decideBump([c(`${t}: x`)]), 'patch', t);
		assert.equal(decideBump([c(`${t}(kapsam): x`)]), 'patch', `${t}(kapsam)`);
	}
	for (const t of ['docs', 'chore', 'test', 'ci', 'bench', 'style']) {
		assert.equal(decideBump([c(`${t}: x`)]), null, t);
	}
});

test('decideBump: kırıcı değişiklik', () => {
	assert.equal(decideBump([c('feat!: x')]), 'major');
	assert.equal(decideBump([c('fix(api)!: x')]), 'major');
	assert.equal(decideBump([c('docs: x', 'açıklama\n\nBREAKING CHANGE: eski kalktı')]), 'major');
	assert.equal(decideBump([c('chore: x', 'BREAKING-CHANGE: eski kalktı')]), 'major');
	assert.equal(decideBump([c('fix: x', 'metin içinde BREAKING CHANGE: geçiyor')]), 'patch');
});

test('decideBump: birleştirme, standart dışı ve boş', () => {
	assert.equal(decideBump([c('Merge branch main')]), null);
	assert.equal(decideBump([c('Merge feat: x')]), null);
	assert.equal(decideBump([c('Bir şeyler düzelttim')]), null);
	assert.equal(decideBump([c('feat x')]), null);
	assert.equal(decideBump([]), null);
});

test('decideBump: en yüksek düzey kazanır', () => {
	assert.equal(decideBump([c('fix: a'), c('feat: b'), c('docs: c')]), 'minor');
	assert.equal(decideBump([c('fix: a'), c('feat: b'), c('refactor!: c')]), 'major');
	assert.equal(decideBump([c('docs: a'), c('fix: b')]), 'patch');
});

test('nextVersion', () => {
	assert.equal(nextVersion('0.3.0', 'patch'), '0.3.1');
	assert.equal(nextVersion('0.3.9', 'minor'), '0.4.0');
	assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
	assert.throws(() => nextVersion('1.2', 'patch'));
	assert.throws(() => nextVersion('1.2.3-beta.1', 'patch'));
});

// --- Tümleşik test: geçici git deposu ---
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release.mjs');

function makeRepo() {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'vc-release-'));
	const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
	git('init', '-q');
	git('config', 'user.name', 'Test');
	git('config', 'user.email', 'test@example.com');
	git('config', 'commit.gpgsign', 'false');
	git('config', 'tag.gpgsign', 'false');
	writeFileSync(path.join(dir, 'package.json'), '{\n  "name": "x",\n  "version": "0.1.0"\n}\n');
	git('add', '.');
	git('commit', '-q', '-m', 'chore: ilk');
	git('tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
	writeFileSync(path.join(dir, 'a.txt'), 'a');
	git('add', '.');
	git('commit', '-q', '-m', 'feat: x');
	git('branch', '-M', 'main');
	return { dir, git };
}

const run = (dir, ...args) =>
	spawnSync(process.execPath, [script, ...args], {
		cwd: dir,
		encoding: 'utf8',
		env: { ...process.env, VC_RELEASE_ROOT: dir }
	});

const pkgVersion = (dir) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

test('CLI: 0.1.0 -> 0.2.0, commit ve etiket; ikinci çalıştırma sürüm yükseltmez', () => {
	const { dir, git } = makeRepo();
	try {
		const dry = run(dir, '--dry-run');
		assert.equal(dry.status, 0, dry.stderr);
		assert.match(dry.stdout, /0\.1\.0 -> 0\.2\.0/);
		assert.equal(pkgVersion(dir), '0.1.0');

		// Sürüm dosyası dışındaki kirli dosya commit'e girmemeli
		writeFileSync(path.join(dir, 'kirli.txt'), 'x');
		const r = run(dir);
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.equal(pkgVersion(dir), '0.2.0');
		assert.equal(git('log', '-1', '--format=%s').trim(), 'chore(release): v0.2.0');
		assert.match(git('log', '-1', '--format=%b'), /- feat: x/);
		assert.equal(git('describe', '--tags', '--abbrev=0').trim(), 'v0.2.0');
		assert.match(git('status', '--porcelain'), /\?\? kirli\.txt/);
		assert.doesNotMatch(git('show', '--stat', '--format=', 'HEAD'), /kirli/);

		const again = run(dir);
		assert.equal(again.status, 0);
		assert.match(again.stdout, /sürümü etkileyen commit yok/);
		assert.equal(git('tag', '--list', 'v*').trim().split('\n').length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('CLI: main dışı dalda --auto değişiklik yapmadan 0 ile çıkar', () => {
	const { dir, git } = makeRepo();
	try {
		git('checkout', '-q', '-b', 'ozellik');
		const r = run(dir, '--auto');
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stderr, /ozellik/);
		assert.equal(pkgVersion(dir), '0.1.0');
		assert.equal(git('tag', '--list', 'v*').trim(), 'v0.1.0');
		assert.equal(run(dir).status, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
