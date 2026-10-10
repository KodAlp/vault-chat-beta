import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	CONVERTED_IMAGE_NAME_RE,
	rewriteConvertedImageLinks,
	relinkAttachmentsForMove,
	importConvertedImages
} from './converted-images';
import { attachmentsDir } from './attachments';
import type { VaultContext } from './vaults';

const A = 'a2694c9b3808ec89.png';
const B = '0123456789abcdef.jpg';

function tmpVault(): VaultContext {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'converted-images-test-'));
	const libraryRoot = path.join(dir, 'library');
	fs.mkdirSync(libraryRoot, { recursive: true });
	return { id: 'test', name: 'Test', dir, libraryRoot, indexDbPath: path.join(dir, 'index.db'), studyDbPath: path.join(dir, 'study.db') };
}

test('file name allowlist', () => {
	assert.ok(CONVERTED_IMAGE_NAME_RE.test(A));
	assert.ok(CONVERTED_IMAGE_NAME_RE.test(B));
	for (const bad of ['../a2694c9b3808ec89.png', 'a2694c9b3808ec8.png', 'A2694C9B3808EC89.png', 'a2694c9b3808ec89.gif', 'a2694c9b3808ec89.png/x', 'a2694c9b3808ec89.png\n'])
		assert.equal(CONVERTED_IMAGE_NAME_RE.test(bad), false, bad);
});

test('staged note links to ../attachments/, final note to ../_meta/attachments/', () => {
	const md = `![fig](images/${A})\n<!-- vc:gorsel a2694c9b3808ec89 -->\n*Görsel:* x`;
	const staged = rewriteConvertedImageLinks(md, '_meta/staging/id.md', () => true);
	assert.equal(staged.split('\n')[0], `![fig](../attachments/${A})`);
	assert.equal(staged.split('\n')[1], '<!-- vc:gorsel a2694c9b3808ec89 -->');
	const final = rewriteConvertedImageLinks(md, 'dersler/ml/not.md', () => true);
	assert.equal(final.split('\n')[0], `![fig](../../_meta/attachments/${A})`);
	const top = rewriteConvertedImageLinks(md, 'not.md', () => true);
	assert.equal(top.split('\n')[0], `![fig](_meta/attachments/${A})`);
});

test('unreadable-formula block (ingest/formula_fallback.py): link rewritten, marker and latex fence kept', () => {
	const md =
		'![Okunamayan formül — s. 12](images/0123456789abcdef.png)\n<!-- vc:formul-gorsel 0123456789abcdef s.12 -->\n\n```latex\n![x](images/0123456789abcdef.png)\n```';
	const out = rewriteConvertedImageLinks(md, 'dersler/fizik/not.md', () => true).split('\n');
	assert.equal(out[0], '![Okunamayan formül — s. 12](../../_meta/attachments/0123456789abcdef.png)');
	assert.equal(out[1], '<!-- vc:formul-gorsel 0123456789abcdef s.12 -->');
	assert.equal(out[4], '![x](images/0123456789abcdef.png)');
});

test('not-kept images lose the link; foreign links and fences are untouched', () => {
	const md = ['![x](images/' + A + ')', '![y](https://e.com/images/' + A + ')', '![z](images/evil.png)', '```', '![c](images/' + A + ')', '```'].join('\n');
	const out = rewriteConvertedImageLinks(md, 'n.md', () => false).split('\n');
	assert.equal(out[0], '');
	assert.equal(out[1], '![y](https://e.com/images/' + A + ')');
	assert.equal(out[2], '![z](images/evil.png)');
	assert.equal(out[4], '![c](images/' + A + ')');
});

test('relinkAttachmentsForMove: staging -> final, only attachment links', () => {
	const md = [`![a](../attachments/${A})`, '![u](https://x.y/z.png)', '![d](data:image/png;base64,AAAA)', '![o](../originals/p.png)', '![e](/abs/p.png)', `![t](../attachments/${A} "baslik")`].join('\n');
	const out = relinkAttachmentsForMove(md, '_meta/staging/id.md', 'alan/konu/not.md').split('\n');
	assert.equal(out[0], `![a](../../_meta/attachments/${A})`);
	assert.equal(out[1], '![u](https://x.y/z.png)');
	assert.equal(out[2], '![d](data:image/png;base64,AAAA)');
	assert.equal(out[3], '![o](../originals/p.png)');
	assert.equal(out[4], '![e](/abs/p.png)');
	assert.equal(out[5], `![t](../../_meta/attachments/${A} "baslik")`);
	// round trip
	assert.equal(relinkAttachmentsForMove(out.join('\n'), 'alan/konu/not.md', '_meta/staging/id.md'), md.replace('../originals/p.png', '../originals/p.png'));
});

test('relinkAttachmentsForMove keeps percent-encoding of encoded names', () => {
	const md = '![a](../attachments/my%20pic.png)';
	assert.equal(relinkAttachmentsForMove(md, '_meta/staging/i.md', 'd/n.md'), '![a](../_meta/attachments/my%20pic.png)');
});

test('importConvertedImages copies valid files, drops invalid/missing ones', () => {
	const v = tmpVault();
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-out-'));
	fs.mkdirSync(path.join(work, 'images'));
	fs.writeFileSync(path.join(work, 'images', A), 'png-bytes');
	const outPath = path.join(work, 'note.md');
	const md = `![a](images/${A})\n![b](images/${B})\n![c](images/ffffffffffffffff.png)`;
	// B listed but missing on disk; a traversal name is listed too.
	const out = importConvertedImages(v, { outPath, images: [A, B, '../x.png'] }, '_meta/staging/id.md', md).split('\n');
	assert.equal(out[0], `![a](../attachments/${A})`);
	assert.equal(out[1], '');
	assert.equal(out[2], '');
	assert.equal(fs.readFileSync(path.join(attachmentsDir(v), A), 'utf-8'), 'png-bytes');
	assert.equal(fs.existsSync(path.join(attachmentsDir(v), B)), false);
	assert.equal(fs.existsSync(path.join(v.dir, 'x.png')), false);
});

test('importConvertedImages with no images leaves the text alone', () => {
	const v = tmpVault();
	assert.equal(importConvertedImages(v, { outPath: null }, 'n.md', 'merhaba'), 'merhaba');
});
