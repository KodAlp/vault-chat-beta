import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { originalFileName, findOriginalName, originalPathForSourceSha, keepOriginalCopy, shaPrefix } from './originals';
import type { VaultContext } from './vaults';

// Temp vault only; keepOriginalCopy reads settings from the vault's own _meta/settings.json.
function tmpVault(settings?: object): VaultContext {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'originals-test-'));
	const libraryRoot = path.join(dir, 'library');
	fs.mkdirSync(path.join(libraryRoot, '_meta'), { recursive: true });
	if (settings) fs.writeFileSync(path.join(libraryRoot, '_meta', 'settings.json'), JSON.stringify(settings));
	return { id: 't', name: 't', dir, libraryRoot, indexDbPath: path.join(dir, 'index.db'), studyDbPath: path.join(dir, 'study.db') };
}

function srcFile(content: string, name = 'ders.pdf'): { abs: string; sha: string } {
	const abs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'originals-src-')), name);
	fs.writeFileSync(abs, content);
	return { abs, sha: crypto.createHash('sha256').update(content).digest('hex') };
}

const SHA = 'abcdef0123456789' + '0'.repeat(48);

test('originalFileName is <sha16>-<safe name>; bad hashes give null', () => {
	assert.equal(originalFileName(SHA.toUpperCase(), 'ders.pdf'), 'abcdef0123456789-ders.pdf');
	assert.equal(originalFileName(SHA, '..\\..\\evil.pdf'), 'abcdef0123456789-evil.pdf');
	assert.equal(originalFileName('xyz', 'a.pdf'), null);
	assert.equal(shaPrefix('abcdef012345'), null);
});

test('originalFileName caps a very long name but keeps the extension', () => {
	const n = originalFileName(SHA, 'a'.repeat(300) + '.pdf') as string;
	assert.ok(n.length <= 17 + 120);
	assert.ok(n.endsWith('.pdf'));
});

test('findOriginalName matches by hash prefix only, never a legacy <importId>- file', () => {
	const names = ['11111111-2222-3333-4444-555555555555-eski.pdf', 'abcdef0123456789-ders.pdf'];
	assert.equal(findOriginalName(names, SHA), 'abcdef0123456789-ders.pdf');
	assert.equal(findOriginalName(names, '1'.repeat(64)), null);
	assert.equal(findOriginalName(names, 'nothex'), null);
});

test('keepOriginalCopy: stores once per content, finds it by source_sha256, legacy files untouched', async () => {
	const v = tmpVault({ keepOriginals: true });
	const dir = path.join(v.libraryRoot, '_meta', 'originals');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, '11111111-2222-3333-4444-555555555555-eski.pdf'), 'old');
	const a = srcFile('ayni icerik');
	const first = await keepOriginalCopy(v, a.abs, 'ders.pdf');
	assert.equal(first, `${a.sha.slice(0, 16)}-ders.pdf`);
	// same bytes under another name: deduped to the existing file
	const b = srcFile('ayni icerik', 'baska.pdf');
	assert.equal(await keepOriginalCopy(v, b.abs, 'baska.pdf', b.sha), first);
	assert.equal(fs.readdirSync(dir).length, 2);
	assert.equal(originalPathForSourceSha(v, a.sha), path.join(dir, first as string));
	assert.equal(fs.readFileSync(originalPathForSourceSha(v, a.sha) as string, 'utf-8'), 'ayni icerik');
	assert.equal(originalPathForSourceSha(v, '9'.repeat(64)), null);
});

test('keepOriginalCopy: respects an explicit keepOriginals:false and defaults to on', async () => {
	const off = tmpVault({ keepOriginals: false });
	assert.equal(await keepOriginalCopy(off, srcFile('x').abs, 'a.pdf'), null);
	assert.equal(fs.existsSync(path.join(off.libraryRoot, '_meta', 'originals')), false);
	const dflt = tmpVault();
	assert.ok(await keepOriginalCopy(dflt, srcFile('y').abs, 'a.pdf'));
});

test('originalPathForSourceSha on a vault with no originals folder is null', () => {
	assert.equal(originalPathForSourceSha(tmpVault(), SHA), null);
});
