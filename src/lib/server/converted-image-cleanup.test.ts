import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepConvertedImages, discardStagedNote, collectReferencedImageNames, SWEEP_MIN_AGE_MS } from './converted-image-cleanup';
import { attachmentsDir } from './attachments';
import type { VaultContext } from './vaults';

// All state lives in a temp dir; nothing here touches the app's data/ folder.
function tmpVault(): VaultContext {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-cleanup-test-'));
	const libraryRoot = path.join(dir, 'library');
	fs.mkdirSync(libraryRoot, { recursive: true });
	return { id: 't', name: 't', dir, libraryRoot, indexDbPath: path.join(dir, 'index.db'), studyDbPath: path.join(dir, 'study.db') };
}

const A = '0123456789abcdef.png';
const B = 'fedcba9876543210.jpg';
const C = 'aaaaaaaaaaaaaaaa.png';
const OBS = 'Pasted image 20240101.png';

function put(v: VaultContext, rel: string, text: string, ageMs = 0): string {
	const abs = path.join(v.libraryRoot, ...rel.split('/'));
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, text);
	if (ageMs) {
		const t = new Date(Date.now() - ageMs);
		fs.utimesSync(abs, t, t);
	}
	return abs;
}

const att = (v: VaultContext, name: string) => path.join(v.libraryRoot, '_meta', 'attachments', name);
const OLD = SWEEP_MIN_AGE_MS + 3600_000;

test('sweep: deletes old unreferenced converted images, keeps referenced, fresh and Obsidian ones', async () => {
	const v = tmpVault();
	put(v, '_meta/attachments/' + A, 'x', OLD); // referenced by a note
	put(v, '_meta/attachments/' + B, 'x', OLD); // orphan
	put(v, '_meta/attachments/' + C, 'x', 1000); // orphan but fresh
	put(v, '_meta/attachments/' + OBS, 'x', OLD * 5); // never ours
	put(v, 'alan/not.md', `![a](../_meta/attachments/${A})`);
	const r = await sweepConvertedImages(v);
	assert.equal(r.removed, 1);
	assert.equal(fs.existsSync(att(v, A)), true);
	assert.equal(fs.existsSync(att(v, B)), false);
	assert.equal(fs.existsSync(att(v, C)), true);
	assert.equal(fs.existsSync(att(v, OBS)), true);
});

test('sweep: references from staging and from revisions keep an image alive', async () => {
	const v = tmpVault();
	put(v, '_meta/attachments/' + A, 'x', OLD);
	put(v, '_meta/attachments/' + B, 'x', OLD);
	put(v, '_meta/staging/11111111-1111-1111-1111-111111111111.md', `![a](../attachments/${A})`);
	put(v, '_meta/revisions/alan/not.md/2026-01-01T00-00-00-000Z.md', `![b](../../../attachments/${B})`);
	const r = await sweepConvertedImages(v);
	assert.equal(r.removed, 0);
	assert.equal(fs.existsSync(att(v, A)) && fs.existsSync(att(v, B)), true);
});

test('sweep: nothing old enough means the note scan is skipped; missing folders are fine', async () => {
	const v = tmpVault();
	assert.deepEqual(await sweepConvertedImages(v), { scanned: 0, removed: 0, skippedScan: true });
	put(v, '_meta/attachments/' + A, 'x', 1000);
	const r = await sweepConvertedImages(v);
	assert.equal(r.skippedScan, true);
	assert.equal(fs.existsSync(att(v, A)), true);
});

test('discardStagedNote: deletes the note and only the images no other note uses', async () => {
	const v = tmpVault();
	put(v, '_meta/attachments/' + A, 'x'); // shared with a library note
	put(v, '_meta/attachments/' + B, 'x'); // only this staged note
	put(v, '_meta/attachments/' + OBS, 'x'); // Obsidian attachment mentioned in the note: untouchable
	put(v, 'alan/baska.md', `![a](../_meta/attachments/${A})`);
	const staged = put(
		v,
		'_meta/staging/22222222-2222-2222-2222-222222222222.md',
		`![a](../attachments/${A})\n![b](../attachments/${B})\n![o](../attachments/Pasted%20image%2020240101.png)`
	);
	const n = await discardStagedNote(v, staged);
	assert.equal(n, 1);
	assert.equal(fs.existsSync(staged), false);
	assert.equal(fs.existsSync(att(v, A)), true);
	assert.equal(fs.existsSync(att(v, B)), false);
	assert.equal(fs.existsSync(att(v, OBS)), true);
});

test('discardStagedNote: a missing staged note is a no-op', async () => {
	const v = tmpVault();
	assert.equal(await discardStagedNote(v, path.join(v.libraryRoot, '_meta', 'staging', 'yok.md')), 0);
});

test('the sweep looks in the same folder attachments.ts writes to', () => {
	const v = tmpVault();
	assert.equal(attachmentsDir(v), path.join(v.libraryRoot, '_meta', 'attachments'));
});

test('collectReferencedImageNames does not read the attachments folder or kept originals', async () => {
	const v = tmpVault();
	put(v, '_meta/attachments/readme.md', `![a](${A})`);
	put(v, '_meta/originals/x.md', `![a](${B})`);
	assert.equal((await collectReferencedImageNames(v)).size, 0);
});
