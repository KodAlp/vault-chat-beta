import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sniffImageUpload, storeUploadedImage, MAX_IMAGE_UPLOAD_BYTES } from './attachment-upload';
import { AppError } from './app-error';
import { relativeLibraryLink, resolveRelativeLibraryPath } from '../attachment-link';
import type { VaultContext } from './vaults';

function tmpVault(): VaultContext {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-upload-'));
	const libraryRoot = path.join(dir, 'library');
	fs.mkdirSync(libraryRoot, { recursive: true });
	return { id: 't', name: 'T', dir, libraryRoot, indexDbPath: path.join(dir, 'i.db'), studyDbPath: path.join(dir, 's.db') };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const GIF = Buffer.from('GIF89a-data');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

test('sniffImageUpload recognises png/jpeg/gif/webp from bytes', () => {
	assert.equal(sniffImageUpload(PNG)?.mime, 'image/png');
	assert.equal(sniffImageUpload(JPG)?.mime, 'image/jpeg');
	assert.equal(sniffImageUpload(GIF)?.mime, 'image/gif');
	assert.equal(sniffImageUpload(WEBP)?.mime, 'image/webp');
});

test('sniffImageUpload rejects svg, pdf, html and garbage', () => {
	assert.equal(sniffImageUpload(SVG), null);
	assert.equal(sniffImageUpload(Buffer.from('%PDF-1.7')), null);
	assert.equal(sniffImageUpload(Buffer.from('<html><script>alert(1)</script>')), null);
	assert.equal(sniffImageUpload(Buffer.alloc(0)), null);
});

test('storeUploadedImage writes a content-hash name in the attachments folder, idempotently', () => {
	const v = tmpVault();
	const rel = storeUploadedImage(v, PNG);
	assert.match(rel, /^_meta\/attachments\/up_[0-9a-f]{16}\.png$/);
	assert.ok(fs.readFileSync(path.join(v.libraryRoot, ...rel.split('/'))).equals(PNG));
	assert.equal(storeUploadedImage(v, PNG), rel);
	assert.notEqual(storeUploadedImage(v, JPG), rel);
});

test('storeUploadedImage rejects wrong type (415), empty, and oversize (413) without writing', () => {
	const v = tmpVault();
	const code = (fn: () => unknown) => {
		try {
			fn();
		} catch (e) {
			return e instanceof AppError ? `${e.code}:${e.status}` : 'other';
		}
		return 'none';
	};
	assert.equal(code(() => storeUploadedImage(v, SVG)), 'ATTACHMENT_TYPE_MISMATCH:415');
	assert.equal(code(() => storeUploadedImage(v, Buffer.alloc(0))), 'VALIDATION_REQUIRED:400');
	const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_UPLOAD_BYTES)]);
	assert.equal(code(() => storeUploadedImage(v, big)), 'FILE_TOO_LARGE:413');
	assert.equal(fs.existsSync(path.join(v.libraryRoot, '_meta')), false);
});

test('stored file name derives only from bytes (path safety)', () => {
	const v = tmpVault();
	const rel = storeUploadedImage(v, Buffer.concat([PNG, Buffer.from('../../evil')]));
	assert.ok(!rel.includes('..'));
	const abs = path.resolve(v.libraryRoot, ...rel.split('/'));
	assert.ok(abs.startsWith(path.resolve(v.libraryRoot) + path.sep));
});

test('relativeLibraryLink is the inverse of resolveRelativeLibraryPath', () => {
	const target = '_meta/attachments/up_0123456789abcdef.png';
	for (const note of ['a.md', 'Fizik/Ders 1/not.md', 'x/y.md']) {
		const link = relativeLibraryLink(note, target);
		assert.equal(resolveRelativeLibraryPath(note, decodeURI(link)), target);
	}
	assert.equal(relativeLibraryLink('Fizik/not.md', target), '../_meta/attachments/up_0123456789abcdef.png');
	assert.equal(relativeLibraryLink('Ders 1/n.md', target), '../_meta/attachments/up_0123456789abcdef.png');
});
