import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isPdfBytes, validateLinkUrl, assertPublicHost, loadImportedUrls } from './link-import';

test('isPdfBytes recognizes the %PDF- magic signature', () => {
	assert.equal(isPdfBytes(Buffer.from('%PDF-1.7\n...')), true);
	assert.equal(isPdfBytes(Buffer.from('<!DOCTYPE html><html>')), false);
	assert.equal(isPdfBytes(Buffer.alloc(0)), false);
});

test('validateLinkUrl accepts http/https and rejects everything else', () => {
	assert.equal(validateLinkUrl('https://example.com/page').href, 'https://example.com/page');
	assert.equal(validateLinkUrl(' http://example.com ').href, 'http://example.com/');
	assert.throws(() => validateLinkUrl('not a url'), /Geçersiz bağlantı/);
	assert.throws(() => validateLinkUrl('file:///etc/passwd'), /Desteklenmeyen protokol/);
	assert.throws(() => validateLinkUrl('javascript:alert(1)'), /Desteklenmeyen protokol/);
});

test('assertPublicHost rejects a loopback/private literal IP without any DNS lookup', async () => {
	await assert.rejects(assertPublicHost(new URL('http://127.0.0.1/x')), /Yerel\/özel ağ/);
	await assert.rejects(assertPublicHost(new URL('http://192.168.1.1/x')), /Yerel\/özel ağ/);
	await assert.rejects(assertPublicHost(new URL('http://10.0.0.5/x')), /Yerel\/özel ağ/);
	await assert.rejects(assertPublicHost(new URL('http://169.254.169.254/x')), /Yerel\/özel ağ/);
	await assert.rejects(assertPublicHost(new URL('http://[::1]/x')), /Yerel\/özel ağ/);
});

test('assertPublicHost allows a public literal IP without any DNS lookup', async () => {
	await assert.doesNotReject(assertPublicHost(new URL('http://8.8.8.8/x')));
});

test('assertPublicHost resolves a hostname and rejects when it points at a private address', async () => {
	const resolve4 = async () => ['10.1.2.3'];
	const resolve6 = async () => {
		throw Object.assign(new Error('no AAAA'), { code: 'ENODATA' });
	};
	await assert.rejects(assertPublicHost(new URL('http://internal.example'), resolve4, resolve6), /Yerel\/özel ağ/);
});

test('assertPublicHost resolves a hostname and allows it when the address is public', async () => {
	const resolve4 = async () => ['93.184.216.34'];
	const resolve6 = async () => {
		throw Object.assign(new Error('no AAAA'), { code: 'ENODATA' });
	};
	await assert.doesNotReject(assertPublicHost(new URL('https://example.com'), resolve4, resolve6));
});

test('assertPublicHost rejects when the hostname resolves to nothing', async () => {
	const fail = async () => {
		throw Object.assign(new Error('no record'), { code: 'ENODATA' });
	};
	await assert.rejects(assertPublicHost(new URL('http://nonexistent.invalid'), fail, fail), /çözümlenemedi/);
});

test('loadImportedUrls returns empty set when the log file does not exist', () => {
	assert.deepEqual(loadImportedUrls(path.join(os.tmpdir(), 'does-not-exist-log.jsonl')), new Set());
});

test('loadImportedUrls collects only successful entries, skipping failed ones', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-import-test-'));
	const logPath = path.join(dir, 'import-log.jsonl');
	try {
		const lines = [
			JSON.stringify({ sourceUrl: 'https://a.example/ok', status: 'converted' }),
			JSON.stringify({ sourceUrl: 'https://b.example/review', status: 'needs_review' }),
			JSON.stringify({ sourceUrl: 'https://c.example/failed', status: 'failed' }),
			'not json',
			JSON.stringify({ status: 'converted' }) // no sourceUrl — skipped
		];
		fs.writeFileSync(logPath, lines.join('\n') + '\n');
		const known = loadImportedUrls(logPath);
		assert.deepEqual([...known].sort(), ['https://a.example/ok', 'https://b.example/review']);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
