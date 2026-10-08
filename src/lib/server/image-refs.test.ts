import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractConvertedImageRefs, orphanedImages, unreferencedCandidates, CONVERTED_NAME_RE } from './image-refs';
import { CONVERTED_IMAGE_NAME_RE } from './converted-images';

const A = '0123456789abcdef.png';
const B = 'fedcba9876543210.jpg';
const C = 'aaaaaaaaaaaaaaaa.jpeg';

test('the pure module copy of the name regex is identical to converted-images.ts', () => {
	assert.equal(CONVERTED_NAME_RE.source, CONVERTED_IMAGE_NAME_RE.source);
});

test('extract: links at any folder depth, URL-encoded folders and titles', () => {
	const md = [
		`![a](../../_meta/attachments/${A})`,
		`![b](../x%20y/_meta/attachments/${B} "baslik")`,
		`![c](_meta/attachments/${C})`,
		`![[${A}]]`
	].join('\n');
	assert.deepEqual([...extractConvertedImageRefs(md)].sort(), [A, B, C].sort());
});

test('extract: ignores fenced code (backtick and tilde) and resumes after the fence', () => {
	const md = ['```md', `![x](a/${A})`, '```', `![y](a/${B})`, '~~~', `![z](a/${C})`, '~~~'].join('\n');
	assert.deepEqual([...extractConvertedImageRefs(md)], [B]);
});

test('extract: CRLF text, longer hex runs and non-converted names are not references', () => {
	const md = `![a](x/${A})\r\n![o](_meta/attachments/foto.png)\r\n![h](x/0123456789abcdef0123456789abcdef.png)\r\n![e](x/0123456789abcdef.gif)`;
	assert.deepEqual([...extractConvertedImageRefs(md)], [A]);
});

test('extract: upper-case spelling of a hash still counts (case-insensitive file systems)', () => {
	assert.deepEqual([...extractConvertedImageRefs('![a](x/0123456789ABCDEF.PNG)')], [A]);
});

test('orphanedImages: only unreferenced, old enough, converted-shaped names', () => {
	const day = 24 * 3600 * 1000;
	const now = 10 * day;
	const stored = [
		{ name: A, mtimeMs: now - 2 * day }, // orphan, old
		{ name: B, mtimeMs: now - 2 * day }, // referenced
		{ name: C, mtimeMs: now - 1000 }, // orphan but fresh (in-flight import)
		{ name: 'IMG_0001.png', mtimeMs: now - 9 * day } // Obsidian attachment: never touched
	];
	assert.deepEqual(orphanedImages(stored, new Set([B]), now, day), [A]);
});

test('orphanedImages: age floor is inclusive and a non-converted name is never returned', () => {
	assert.deepEqual(orphanedImages([{ name: A, mtimeMs: 0 }], new Set(), 100, 100), [A]);
	assert.deepEqual(orphanedImages([{ name: '../x.png', mtimeMs: 0 }, { name: 'foto.png', mtimeMs: 0 }], new Set(), 1e12, 0), []);
});

test('unreferencedCandidates keeps only candidates no other note uses', () => {
	assert.deepEqual(unreferencedCandidates([A, B, 'foto.png'], new Set([B])), [A]);
});
