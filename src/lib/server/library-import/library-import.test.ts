import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { AppError } from '../app-error';
import { detectAll, ADAPTERS } from './adapters';
import { resolveSourceRoot, runImport, walkSource, rewriteEmbedsWith, rewriteWikilinksWith, normalizePrefix, stringifyNote, type Indexer } from './common';
import { scanSource, runScanned } from './service';
import { createImportScanRegistry } from './scan-registry';
import type { VaultContext } from '../vaults';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => path.join(FIXTURES, name);

function hasCode(code: string) {
	return (err: unknown) => err instanceof AppError && err.code === code;
}

function tmpDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function tmpVault(): VaultContext {
	const dir = tmpDir('library-import-vault');
	const libraryRoot = path.join(dir, 'library');
	fs.mkdirSync(libraryRoot, { recursive: true });
	return {
		id: 'test',
		name: 'Test',
		dir,
		libraryRoot,
		indexDbPath: path.join(dir, 'index.db'),
		studyDbPath: path.join(dir, 'study.db')
	};
}

/** Real indexing needs an embedding backend; the contract under test is files, links and the log. */
function stubIndexer(): { indexer: Indexer; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		indexer: async (_v, _abs, rel) => {
			calls.push(rel);
		}
	};
}

/** Copies a fixture into a temp dir so a test can edit it. */
function copyFixture(name: string): string {
	const dst = tmpDir(`library-import-src-${name}`);
	fs.cpSync(fixture(name), dst, { recursive: true });
	return fs.realpathSync.native(dst);
}

function read(v: VaultContext, rel: string): string {
	return fs.readFileSync(path.join(v.libraryRoot, rel), 'utf-8');
}

async function importFixture(adapterId: keyof typeof ADAPTERS, root: string, v: VaultContext, targetPrefix?: string) {
	const adapter = ADAPTERS[adapterId];
	const real = fs.realpathSync.native(root);
	const plan = await adapter.plan(real, walkSource(real));
	const { indexer, calls } = stubIndexer();
	const summary = await runImport(v, adapter, plan, real, { indexer, targetPrefix });
	return { plan, summary, calls };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test('detectAll ranks the specific adapter first for each fixture', async () => {
	const obs = await detectAll(fixture('obsidian'));
	assert.equal(obs[0].adapter, 'markdown-folder');
	assert.equal(obs[0].flavor, 'obsidian');
	assert.ok(obs[0].confidence >= 0.9);
	assert.equal(obs.find((d) => d.adapter === 'logseq')?.match, false);
	assert.equal(obs.find((d) => d.adapter === 'joplin-export')?.match, false);

	const logseq = await detectAll(fixture('logseq'));
	assert.equal(logseq[0].adapter, 'logseq');
	assert.ok(logseq[0].confidence > (logseq.find((d) => d.adapter === 'markdown-folder')?.confidence ?? 1));
	assert.deepEqual(logseq[0].warnings, [{ code: 'orgSkipped', count: 1 }]);

	const joplin = await detectAll(fixture('joplin'));
	assert.equal(joplin[0].adapter, 'joplin-export');
	assert.equal(joplin.find((d) => d.adapter === 'markdown-folder')?.flavor, 'plain');
});

test('markdown-folder detects the dendron, foam and zettlr flavors and warns about dendron dot names', async () => {
	const dendron = await detectAll(fixture('dendron'));
	assert.equal(dendron[0].adapter, 'markdown-folder');
	assert.equal(dendron[0].flavor, 'dendron');
	assert.deepEqual(dendron[0].warnings, [{ code: 'dendronDotNames' }]);

	for (const [marker, flavor] of [
		['.foam', 'foam'],
		['.ztr-directory', 'zettlr']
	] as const) {
		const dir = tmpDir('library-import-flavor');
		fs.writeFileSync(path.join(dir, 'a.md'), 'x');
		if (marker === '.foam') fs.mkdirSync(path.join(dir, marker));
		else fs.writeFileSync(path.join(dir, marker), '{}');
		const res = await detectAll(fs.realpathSync.native(dir));
		assert.equal(res[0].flavor, flavor);
	}

	const plain = tmpDir('library-import-plain');
	fs.writeFileSync(path.join(plain, 'a.md'), 'x');
	const res = await detectAll(fs.realpathSync.native(plain));
	assert.equal(res[0].flavor, 'plain');
	assert.ok(res[0].confidence < 0.5);
});

test('a Logseq DB-version graph (no pages/) is not a match and carries the warning code', async () => {
	const dir = tmpDir('library-import-logseq-db');
	fs.mkdirSync(path.join(dir, 'logseq'));
	fs.writeFileSync(path.join(dir, 'logseq', 'config.edn'), '{}');
	fs.writeFileSync(path.join(dir, 'db.sqlite'), 'binary');
	const res = await detectAll(fs.realpathSync.native(dir));
	const logseq = res.find((d) => d.adapter === 'logseq')!;
	assert.equal(logseq.match, false);
	assert.deepEqual(logseq.warnings, [{ code: 'logseqDbGraph' }]);
	// The SQLite file is never read or listed as a note.
	const summary = await scanSource(tmpVault(), dir, 'logseq', [], createImportScanRegistry());
	assert.equal(summary.scanId, null);
	assert.equal(summary.notes, 0);
	assert.ok(summary.warnings.some((w) => w.code === 'logseqDbGraph'));
});

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

test('obsidian plan: counts, excluded folders, skip reasons, attachments from an attachments/ folder', async () => {
	const root = fs.realpathSync.native(fixture('obsidian'));
	const plan = await ADAPTERS['markdown-folder'].plan(root, walkSource(root));
	assert.equal(plan.flavor, 'obsidian');
	assert.deepEqual(
		plan.entries.map((e) => e.rel),
		['Giris.md', 'Konu/Alt/Transistor.md', 'Konu/Diyot.md']
	);
	assert.equal(plan.notes, 3);
	// devre.png + sema.pdf live in attachments/, which the indexer excludes as a NOTE folder only.
	assert.equal(plan.attachments, 2);
	assert.deepEqual(plan.skipped, [{ rel: 'Konu/liste.txt', reason: 'unsupported' }]);
	assert.deepEqual(plan.sampleTargets, ['Giris.md', 'Konu/Alt/Transistor.md', 'Konu/Diyot.md']);
});

test('logseq plan: pages, namespaces, journals, org skipped, bak ignored', async () => {
	const root = fs.realpathSync.native(fixture('logseq'));
	const plan = await ADAPTERS.logseq.plan(root, walkSource(root));
	assert.deepEqual(
		plan.entries.map((e) => [e.rel, e.target]),
		[
			['journals/2026_10_05.md', 'gunluk/2026-10-05.md'],
			['pages/Diyot.md', 'Diyot.md'],
			['pages/Elektronik___Devreler.md', 'Elektronik/Devreler.md']
		]
	);
	assert.equal(plan.attachments, 1);
	assert.deepEqual(plan.skipped, [{ rel: 'pages/Org Notu.org', reason: 'orgFile' }]);
	assert.deepEqual(plan.warnings, [{ code: 'orgSkipped', count: 1 }]);
});

test('joplin plan: notebooks keep their folders, resources are indexed, unsupported resources skipped', async () => {
	const root = fs.realpathSync.native(fixture('joplin'));
	const plan = await ADAPTERS['joplin-export'].plan(root, walkSource(root));
	assert.deepEqual(plan.entries.map((e) => e.target).sort(), ['Elektronik/Devreler/Direnc Hesabi.md', 'Genel/Diger Not.md', 'Kok Not.md']);
	assert.equal(plan.attachments, 1);
	assert.deepEqual(plan.skipped, [{ rel: '_resources/fedcba9876543210fedcba9876543210.zip', reason: 'unsupported' }]);
	// Two of three notes carry no id in their frontmatter, so :/id note links cannot resolve for them.
	assert.deepEqual(plan.warnings, [{ code: 'joplinNoIds', count: 2 }]);
});

// ---------------------------------------------------------------------------
// Transforms (through runImport, against a temp library)
// ---------------------------------------------------------------------------

test('obsidian import: wikilinks, embeds, relative images, frontmatter, excluded folders', async () => {
	const v = tmpVault();
	const { summary, calls } = await importFixture('markdown-folder', fixture('obsidian'), v);
	assert.deepEqual(summary.items.map((i) => [i.fileName, i.status]), [
		['Giris.md', 'converted'],
		['Konu/Alt/Transistor.md', 'converted'],
		['Konu/Diyot.md', 'needs_review']
	]);
	assert.deepEqual(calls, ['Giris.md', 'Konu/Alt/Transistor.md', 'Konu/Diyot.md']);

	const giris = read(v, 'Giris.md');
	assert.match(giris, /\[Diyot\]\(Konu\/Diyot\.md\)/);
	assert.match(giris, /\[transistor notu\]\(Konu\/Alt\/Transistor\.md\)/);
	assert.match(giris, /Eksik: Yok Boyle Not\./); // unresolved wikilink degrades to its label
	assert.equal((giris.match(/!\[\]\(_meta\/attachments\/devre\.png\)/g) ?? []).length, 2); // ![[devre.png|300]] and ![](attachments/devre.png)
	assert.match(giris, /`\[\[Diyot\]\]`/); // inside code: untouched
	const fm = matter(giris).data;
	assert.equal(fm.converted_by, 'obsidian-import');
	assert.equal(fm.source_file, 'Giris.md');
	assert.equal(fm.needs_review, undefined);

	const diyot = matter(read(v, 'Konu/Diyot.md'));
	assert.equal(diyot.data.title, 'Diyot');
	assert.equal(diyot.data.domain, 'genel');
	assert.equal(diyot.data.needs_review, true);
	assert.match(diyot.content, /\[Giris\]\(\.\.\/Giris\.md\)/);

	const transistor = read(v, 'Konu/Alt/Transistor.md');
	assert.match(transistor, /\[Giris\]\(\.\.\/\.\.\/Giris\.md\)/);
	assert.match(transistor, /\[sema\.pdf\]\(\.\.\/\.\.\/_meta\/attachments\/sema\.pdf\)/);

	assert.ok(fs.existsSync(path.join(v.libraryRoot, '_meta', 'attachments', 'devre.png')));
	assert.ok(fs.existsSync(path.join(v.libraryRoot, '_meta', 'attachments', 'sema.pdf')));
	// templates/ and raw/ are indexer-excluded: their notes are never imported.
	assert.equal(fs.existsSync(path.join(v.libraryRoot, 'templates')), false);
	assert.equal(fs.existsSync(path.join(v.libraryRoot, 'raw')), false);
});

test('logseq import: properties, block refs/embeds, tasks, tags, links, assets, journals', async () => {
	const v = tmpVault();
	const { summary } = await importFixture('logseq', fixture('logseq'), v);
	assert.equal(summary.items.filter((i) => i.status === 'failed').length, 0);

	const diyot = matter(read(v, 'Diyot.md'));
	assert.equal(diyot.data.title, 'Diyot (yari iletken)');
	assert.deepEqual(diyot.data.aliases, ['Diode']);
	assert.deepEqual([...diyot.data.tags].sort(), ['devre', 'elektronik', 'yariiletken']);
	assert.equal(diyot.data.level, 'undergraduate');
	assert.equal(diyot.data.converted_by, 'logseq-import');
	assert.doesNotMatch(diyot.content, /id::/);
	assert.doesNotMatch(diyot.content, /collapsed::/);
	assert.match(diyot.content, /- \[ \] ders notlarini tamamla/);
	assert.match(diyot.content, /- \[x\] devreyi kur/);
	assert.match(diyot.content, /\[Elektronik\/Devreler\]\(Elektronik\/Devreler\.md\)/);
	assert.match(diyot.content, /#devre/); // no page of that name: stays plain text
	assert.match(diyot.content, /- !\[sema\]\(_meta\/attachments\/image_1_0\.png\)\n/); // {:height ...} stripped, asset relinked
	assert.match(diyot.content, /`\(\(11111111-1111-4111-8111-111111111111\)\)`/); // in code: untouched
	assert.ok(fs.existsSync(path.join(v.libraryRoot, '_meta', 'attachments', 'image_1_0.png')));

	const dev = matter(read(v, 'Elektronik/Devreler.md'));
	assert.match(dev.content, /\[Diode\]\(\.\.\/Diyot\.md\)/); // alias resolves
	assert.match(dev.content, /Blok referansi: Diyot akimi tek yone gecirir \(\[Diyot \(yari iletken\)\]\(\.\.\/Diyot\.md\)\)/);
	assert.match(dev.content, /Bilinmeyen: \(ref\)/);
	assert.match(dev.content, /- > Diyot akimi tek yone gecirir \(\[Diyot \(yari iletken\)\]\(\.\.\/Diyot\.md\)\)/); // embed block -> blockquote
	assert.match(dev.content, /- \[Diyot \(yari iletken\)\]\(\.\.\/Diyot\.md\)\n/); // embed page -> link
	assert.match(dev.content, /#cok kelimeli etiket ve #devre ve #123/);
	assert.match(dev.content, /SCHEDULED: <2026-10-06 Tue>/);
	assert.deepEqual([...dev.data.tags].sort(), ['cok kelimeli etiket', 'devre']);
	assert.equal(dev.data.unresolved_block_refs, 1);

	const journal = matter(read(v, 'gunluk/2026-10-05.md'));
	assert.equal(journal.data.title, '2026-10-05');
	assert.equal(journal.data.domain, 'gunluk');
	assert.match(journal.content, /\[Diyot \(yari iletken\)\]\(\.\.\/Diyot\.md\)/);
	assert.match(journal.content, /- \[ \] ogle yemegi/);
	// logseq/bak copies and the .org page are never imported.
	assert.equal(fs.existsSync(path.join(v.libraryRoot, 'old.md')), false);
	assert.equal(fs.existsSync(path.join(v.libraryRoot, 'Org Notu.md')), false);
});

test('joplin import: relative and :/id links, html img, frontmatter mapping, unresolved ids', async () => {
	const v = tmpVault();
	const { summary } = await importFixture('joplin-export', fixture('joplin'), v);
	assert.equal(summary.items.filter((i) => i.status === 'failed').length, 0);

	const note = matter(read(v, 'Elektronik/Devreler/Direnc Hesabi.md'));
	const img = '../../_meta/attachments/0123456789abcdef0123456789abcdef.png';
	assert.equal((note.content.match(new RegExp(`!\\[[^\\]]*\\]\\(${img.replace(/\./g, '\\.')}\\)`, 'g')) ?? []).length, 3);
	assert.match(note.content, /\[Diger Not\]\(\.\.\/\.\.\/Genel\/Diger%20Not\.md\)/);
	assert.match(note.content, /\[id ile\]\(\.\.\/\.\.\/Genel\/Diger%20Not\.md\)/); // :/id of a note with an id in its frontmatter
	assert.match(note.content, / ve olmayan\n/); // unknown :/id -> link dropped, text kept
	assert.doesNotMatch(note.content, /:\/bbbb/);
	assert.match(note.content, /\(\.\.\/\.\.\/_resources\/fedcba9876543210fedcba9876543210\.zip\)/); // unsupported resource: left as it was
	assert.equal(note.data.title, 'Direnc Hesabi');
	assert.deepEqual(note.data.tags, ['elektronik', 'direnc']);
	assert.ok(note.data.created);
	assert.equal(note.data.latitude, undefined);
	assert.equal(note.data.author, undefined);
	assert.equal(note.data.domain, 'Elektronik'); // top-level notebook
	assert.equal(note.data.converted_by, 'joplin-import');

	const kok = matter(read(v, 'Kok Not.md'));
	assert.deepEqual(kok.data.tags, ['a', 'b']);
	assert.equal(kok.data.domain, 'genel');
	assert.equal(kok.data.needs_review, true);
	assert.ok(fs.existsSync(path.join(v.libraryRoot, '_meta', 'attachments', '0123456789abcdef0123456789abcdef.png')));
});

test('imported notes are written with LF even from a CRLF source (regression)', () => {
	const out = stringifyNote('satir 1\r\nsatir 2\r\n\r\nson\r', { title: 'x' });
	assert.equal(out.includes('\r'), false);
	assert.match(out, /\nsatir 1\nsatir 2\n\nson\n/);
});

test('an embed of an attachment is not eaten by the wikilink pass (regression)', () => {
	const embedded = rewriteEmbedsWith('![[a.png]] and ![[Note]] and ![[nope]]', 'x.md', {
		attachment: (n) => (n === 'a.png' ? '_meta/attachments/a.png' : null),
		note: (n) => (n === 'Note' ? 'sub/Note.md' : undefined)
	});
	assert.equal(embedded, '![](_meta/attachments/a.png) and [Note](sub/Note.md) and ![[nope]]');
	// the leftover ![[nope]] must stay intact through the wikilink pass
	assert.equal(rewriteWikilinksWith(embedded, 'x.md', () => undefined), embedded);
});

// ---------------------------------------------------------------------------
// Incremental, prefix, safety
// ---------------------------------------------------------------------------

test('a second run skips unchanged notes and re-imports an edited one', async () => {
	const v = tmpVault();
	const src = copyFixture('obsidian');
	const first = await importFixture('markdown-folder', src, v);
	assert.equal(first.summary.items.filter((i) => i.status === 'skipped').length, 0);

	const second = await importFixture('markdown-folder', src, v);
	assert.deepEqual(second.summary.items.map((i) => i.status), ['skipped', 'skipped', 'skipped']);
	assert.deepEqual(second.calls, []);

	fs.appendFileSync(path.join(src, 'Konu', 'Diyot.md'), '\nyeni satir\n');
	const third = await importFixture('markdown-folder', src, v);
	assert.deepEqual(third.summary.items.map((i) => [i.fileName, i.status]), [
		['Giris.md', 'skipped'],
		['Konu/Alt/Transistor.md', 'skipped'],
		['Konu/Diyot.md', 'needs_review']
	]);
	assert.match(read(v, 'Konu/Diyot.md'), /yeni satir/);

	// A note deleted from the library comes back on the next run even though its source hash is unchanged.
	fs.rmSync(path.join(v.libraryRoot, 'Giris.md'));
	const fourth = await importFixture('markdown-folder', src, v);
	assert.equal(fourth.summary.items.find((i) => i.fileName === 'Giris.md')?.status, 'converted');
});

test('the import log records adapter and final path', async () => {
	const v = tmpVault();
	await importFixture('logseq', fixture('logseq'), v);
	const lines = fs
		.readFileSync(path.join(v.libraryRoot, '_meta', 'import-log.jsonl'), 'utf-8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	assert.deepEqual(lines.map((l) => l.sourcePath).sort(), ['Diyot.md', 'Elektronik/Devreler.md', 'gunluk/2026-10-05.md']);
	assert.ok(lines.every((l) => l.adapter === 'logseq' && typeof l.sha256 === 'string'));
});

test('targetPrefix puts everything under one sanitized folder, links and attachments stay correct', async () => {
	const v = tmpVault();
	const { summary } = await importFixture('markdown-folder', fixture('obsidian'), v, 'Kaynak Klasoru');
	assert.equal(summary.items.filter((i) => i.status === 'failed').length, 0);
	const giris = read(v, 'Kaynak Klasoru/Giris.md');
	assert.match(giris, /\[Diyot\]\(Konu\/Diyot\.md\)/);
	assert.match(giris, /!\[\]\(\.\.\/_meta\/attachments\/devre\.png\)/);
	assert.match(read(v, 'Kaynak Klasoru/Konu/Alt/Transistor.md'), /\(\.\.\/\.\.\/\.\.\/_meta\/attachments\/sema\.pdf\)/);
	assert.equal(fs.existsSync(path.join(v.libraryRoot, 'Giris.md')), false);

	// A hostile prefix cannot add or remove path levels, and cannot name _meta.
	assert.equal(normalizePrefix('../evil'), 'evil');
	assert.equal(normalizePrefix('a/b\\c'), 'abc');
	assert.equal(normalizePrefix('_meta'), '_meta-klasoru');
	assert.equal(normalizePrefix('   '), '');

	// The incremental key includes the prefix: importing the same source without it is a separate set of notes.
	const root = await importFixture('markdown-folder', fixture('obsidian'), v);
	assert.equal(root.summary.items.filter((i) => i.status === 'skipped').length, 0);
});

test('resolveSourceRoot rejects relative, missing, root, file and app-owned paths', () => {
	const v = tmpVault();
	const protectedDirs = [v.dir, v.libraryRoot];
	const bad = hasCode('IMPORT_SOURCE_INVALID');
	assert.throws(() => resolveSourceRoot('relative/path', protectedDirs), bad);
	assert.throws(() => resolveSourceRoot(path.join(os.tmpdir(), 'definitely-not-here-xyz'), protectedDirs), bad);
	assert.throws(() => resolveSourceRoot(path.parse(os.tmpdir()).root, protectedDirs), bad);
	assert.throws(() => resolveSourceRoot(path.join(FIXTURES, 'obsidian', 'Giris.md'), protectedDirs), bad);
	assert.throws(() => resolveSourceRoot(v.libraryRoot, protectedDirs), bad);
	assert.throws(() => resolveSourceRoot(path.join(v.dir, 'anything'), protectedDirs), bad);
	assert.throws(() => resolveSourceRoot(42, protectedDirs), bad);
	assert.throws(() => resolveSourceRoot('/x\0y', protectedDirs), bad);
	assert.equal(resolveSourceRoot(fixture('obsidian'), protectedDirs), fs.realpathSync.native(fixture('obsidian')));
});

function trySymlink(target: string, link: string, type: 'file' | 'dir'): boolean {
	try {
		fs.symlinkSync(target, link, type === 'dir' ? 'junction' : 'file');
		return true;
	} catch {
		return false; // no symlink privilege (Windows without developer mode)
	}
}

test('symlinked notes and folders are never walked or imported', async () => {
	const outside = tmpDir('library-import-outside');
	fs.writeFileSync(path.join(outside, 'secret.md'), 'SECRET');
	fs.writeFileSync(path.join(outside, 'secret.png'), 'SECRET');
	const src = tmpDir('library-import-symlinks');
	fs.writeFileSync(path.join(src, 'ok.md'), 'fine');
	const linkedFile = trySymlink(path.join(outside, 'secret.md'), path.join(src, 'linked.md'), 'file');
	const linkedDir = trySymlink(outside, path.join(src, 'linkeddir'), 'dir');
	if (!linkedFile && !linkedDir) return; // cannot create symlinks here

	const root = fs.realpathSync.native(src);
	const tree = walkSource(root);
	assert.deepEqual(tree.files.map((f) => f.rel), ['ok.md']);

	const v = tmpVault();
	const { summary } = await importFixtureRoot(root, v);
	assert.deepEqual(summary.items.map((i) => i.fileName), ['ok.md']);
	assert.equal(fs.existsSync(path.join(v.libraryRoot, 'linked.md')), false);
});

async function importFixtureRoot(root: string, v: VaultContext) {
	return importFixture('markdown-folder', root, v);
}

test('a note swapped for a symlink between scan and import fails instead of being read', async () => {
	const outside = tmpDir('library-import-outside2');
	fs.writeFileSync(path.join(outside, 'secret.md'), 'SECRET');
	const src = tmpDir('library-import-swap');
	fs.writeFileSync(path.join(src, 'a.md'), 'fine');
	const root = fs.realpathSync.native(src);
	const adapter = ADAPTERS['markdown-folder'];
	const plan = await adapter.plan(root, walkSource(root));
	fs.rmSync(path.join(src, 'a.md'));
	if (!trySymlink(path.join(outside, 'secret.md'), path.join(src, 'a.md'), 'file')) return;

	const v = tmpVault();
	const { indexer } = stubIndexer();
	const summary = await runImport(v, adapter, plan, root, { indexer });
	assert.equal(summary.items[0].status, 'failed');
	assert.equal(summary.items[0].code, 'SCAN_PATH_INVALID');
	assert.equal(fs.existsSync(path.join(v.libraryRoot, 'a.md')), false);
});

// ---------------------------------------------------------------------------
// Scan / run service
// ---------------------------------------------------------------------------

test('scanSource returns a summary without internals; runScanned imports only what the scan recorded', async () => {
	const v = tmpVault();
	const registry = createImportScanRegistry();
	const src = copyFixture('logseq');
	const summary = await scanSource(v, src, undefined, [v.dir], registry);
	assert.equal(summary.adapter, 'logseq');
	assert.equal(summary.matched, true);
	assert.equal(summary.notes, 3);
	assert.equal(summary.attachments, 1);
	assert.deepEqual(summary.skippedByReason, { orgFile: 1 });
	assert.deepEqual(summary.sampleTargets, ['gunluk/2026-10-05.md', 'Diyot.md', 'Elektronik/Devreler.md']);
	assert.equal(summary.detected[0].adapter, 'logseq');
	assert.ok(!('entries' in summary) && !('state' in summary));
	assert.equal(typeof summary.scanId, 'string');

	// A note that appears after the scan is not part of the plan.
	fs.writeFileSync(path.join(src, 'pages', 'Sonradan.md'), '- yeni');
	const { indexer, calls } = stubIndexer();
	const result = await runScanned(v, summary.scanId, { adapter: 'logseq', indexer, registry });
	assert.equal(result.items.length, 3);
	assert.equal(calls.length, 3);
	assert.equal(fs.existsSync(path.join(v.libraryRoot, 'Sonradan.md')), false);
});

test('coded errors: unknown adapter, nothing importable, expired scan, adapter mismatch, wrong vault', async () => {
	const v = tmpVault();
	const registry = createImportScanRegistry();
	await assert.rejects(() => scanSource(v, fixture('obsidian'), 'notion', [], registry), hasCode('IMPORT_ADAPTER_UNKNOWN'));
	await assert.rejects(() => scanSource(v, 'relative', undefined, [], registry), hasCode('IMPORT_SOURCE_INVALID'));
	const empty = tmpDir('library-import-empty');
	await assert.rejects(() => scanSource(v, empty, undefined, [], registry), hasCode('IMPORT_NOTHING_TO_IMPORT'));

	await assert.rejects(() => runScanned(v, 'no-such-id', { registry }), hasCode('SCAN_EXPIRED'));
	await assert.rejects(() => runScanned(v, undefined, { registry }), hasCode('SCAN_EXPIRED'));
	const s = await scanSource(v, fixture('obsidian'), 'markdown-folder', [], registry);
	await assert.rejects(() => runScanned(v, s.scanId, { adapter: 'logseq', registry }), hasCode('IMPORT_ADAPTER_MISMATCH'));
	// A scan belongs to the vault that made it.
	await assert.rejects(() => runScanned({ ...v, id: 'other' }, s.scanId, { registry }), hasCode('SCAN_EXPIRED'));
});

test('a hand-picked adapter that does not match still plans, and says so', async () => {
	const v = tmpVault();
	const s = await scanSource(v, fixture('obsidian'), 'joplin-export', [], createImportScanRegistry());
	assert.equal(s.adapter, 'joplin-export');
	assert.equal(s.matched, false);
	assert.equal(s.detected[0].adapter, 'markdown-folder'); // what the folder actually looks like
});

test('scan registry expires entries and caps its size', () => {
	let t = 0;
	let n = 0;
	const reg = createImportScanRegistry({ ttlMs: 1000, maxScans: 2, now: () => t, newId: () => `id${n++}` });
	const plan = { adapter: 'markdown-folder' as const, notes: 0, attachments: 0, skipped: [], sampleTargets: [], warnings: [], entries: [], state: {} };
	const a = reg.add('v', '/r', 'markdown-folder', plan);
	reg.add('v', '/r', 'markdown-folder', plan);
	reg.add('v', '/r', 'markdown-folder', plan);
	assert.equal(reg.get(a, 'v'), undefined); // oldest evicted at the cap
	assert.equal(reg.size(), 2);
	t = 2000;
	assert.equal(reg.get('id1', 'v'), undefined); // expired
	assert.equal(reg.size(), 0);
});
