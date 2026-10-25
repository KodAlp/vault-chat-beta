import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyAttachmentIntoLibrary, attachmentsDir, ATTACHMENT_EXT, sniffAttachmentContentType } from './attachments';
import type { VaultContext } from './vaults';

function tmpVault(): VaultContext {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-test-'));
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

function tmpSourceFile(name: string, content = 'fake-bytes'): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-src-'));
	const abs = path.join(dir, name);
	fs.writeFileSync(abs, content);
	return abs;
}

test('copyAttachmentIntoLibrary copies an allowed extension and returns a library-relative path', () => {
	const v = tmpVault();
	const src = tmpSourceFile('diagram.png');
	const rel = copyAttachmentIntoLibrary(v, src, 'diagram.png');
	assert.equal(rel, '_meta/attachments/diagram.png');
	assert.equal(fs.existsSync(path.join(attachmentsDir(v), 'diagram.png')), true);
});

test('copyAttachmentIntoLibrary rejects an extension outside the allowlist', () => {
	const v = tmpVault();
	const src = tmpSourceFile('script.exe');
	const rel = copyAttachmentIntoLibrary(v, src, 'script.exe');
	assert.equal(rel, null);
	assert.equal(fs.existsSync(path.join(attachmentsDir(v), 'script.exe')), false);
});

test('copyAttachmentIntoLibrary is idempotent — a second call does not re-copy or throw', () => {
	const v = tmpVault();
	const src = tmpSourceFile('fig.jpg', 'first-version');
	copyAttachmentIntoLibrary(v, src, 'fig.jpg');
	// Simulate a second import pass where the source changed but the dest name did not:
	// the existing copy wins (same behavior as importObsidian.ts always had).
	fs.writeFileSync(src, 'second-version');
	copyAttachmentIntoLibrary(v, src, 'fig.jpg');
	const destContent = fs.readFileSync(path.join(attachmentsDir(v), 'fig.jpg'), 'utf-8');
	assert.equal(destContent, 'first-version');
});

test('ATTACHMENT_EXT covers the supported image types', () => {
	for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf']) {
		assert.equal(ATTACHMENT_EXT.has(ext), true);
	}
	assert.equal(ATTACHMENT_EXT.has('.exe'), false);
});

test('sniffAttachmentContentType accepts real magic bytes for every binary type', () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
	assert.equal(sniffAttachmentContentType('.png', png), 'image/png');

	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
	assert.equal(sniffAttachmentContentType('.jpg', jpeg), 'image/jpeg');
	assert.equal(sniffAttachmentContentType('.jpeg', jpeg), 'image/jpeg');

	const gif = Buffer.from('GIF89a' + '\0\0\0\0', 'ascii');
	assert.equal(sniffAttachmentContentType('.gif', gif), 'image/gif');

	const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii')]);
	assert.equal(sniffAttachmentContentType('.webp', webp), 'image/webp');

	const pdf = Buffer.from('%PDF-1.7\n%...', 'ascii');
	assert.equal(sniffAttachmentContentType('.pdf', pdf), 'application/pdf');

	const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf-8');
	assert.equal(sniffAttachmentContentType('.svg', svg), 'image/svg+xml');
});

test('sniffAttachmentContentType rejects a mismatched extension/content pair (renamed file attack)', () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
	assert.equal(sniffAttachmentContentType('.jpg', png), null);
	assert.equal(sniffAttachmentContentType('.svg', png), null);
	assert.equal(sniffAttachmentContentType('.pdf', Buffer.from('not a pdf')), null);
});

test('sniffAttachmentContentType rejects an SVG carrying a script payload despite a valid <svg> tag', () => {
	const malicious = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf-8');
	assert.equal(sniffAttachmentContentType('.svg', malicious), null);

	const onload = Buffer.from('<svg onload="alert(1)"></svg>', 'utf-8');
	assert.equal(sniffAttachmentContentType('.svg', onload), null);

	const jsHref = Buffer.from('<svg><a href="javascript:alert(1)">x</a></svg>', 'utf-8');
	assert.equal(sniffAttachmentContentType('.svg', jsHref), null);
});

test('sniffAttachmentContentType rejects an unknown extension outright', () => {
	assert.equal(sniffAttachmentContentType('.exe', Buffer.from([0, 1, 2, 3])), null);
});
