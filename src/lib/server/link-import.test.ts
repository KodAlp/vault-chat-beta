import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isPdfBytes, validateLinkUrl, assertPublicHost, pinnedDispatcher, loadImportedUrls } from './link-import';

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

// 2026-09-23 report: SSRF guard bypassed by 8 address forms the hand-rolled
// string-prefix/bit-mask version did not recognize as private. All measured
// against a real isolated test server for the IPv4-mapped case (a service
// bound only to 127.0.0.1 was reachable and its response got converted into
// the vault). Rewritten on node:net's built-in BlockList, which normalizes
// IPv4-mapped IPv6 natively — these are now all rejected.
test('assertPublicHost rejects every bypass form from the 2026-09-23 report', async () => {
	const bypassed = [
		'http://[::ffff:127.0.0.1]/x', // IPv4-mapped IPv6, dotted form — the one proven live
		'http://[::ffff:7f00:1]/x', // IPv4-mapped IPv6, hex form (same address, different syntax)
		'http://[::ffff:192.168.1.1]/x', // IPv4-mapped IPv6 of a private (not just loopback) address
		'http://[64:ff9b::7f00:1]/x', // NAT64 well-known prefix embedding 127.0.0.1
		'http://[fe90::1]/x', // link-local, inside fe80::/10 but outside a literal "fe80" prefix match
		'http://[fec0::1]/x', // deprecated IPv6 site-local
		'http://198.18.0.1/x', // IPv4 benchmark range (RFC 2544)
		'http://224.0.0.1/x', // IPv4 multicast
		'http://255.255.255.255/x' // IPv4 reserved/broadcast (240.0.0.0/4)
	];
	for (const link of bypassed) {
		await assert.rejects(assertPublicHost(new URL(link)), /Yerel\/özel ağ/, `expected ${link} to be rejected`);
	}
});

test('assertPublicHost still allows real public addresses in both families, unaffected by the rewrite', async () => {
	await assert.doesNotReject(assertPublicHost(new URL('http://93.184.216.34/x')));
	await assert.doesNotReject(assertPublicHost(new URL('http://[2001:4860:4860::8888]/x'))); // Google public DNS, v6
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

// pinnedDispatcher: closes the DNS-rebinding gap between assertPublicHost's
// validation and the real connection — the fetch below deliberately uses a
// hostname that never resolves to anything real, to prove the request only
// reaches the loopback server because pinnedDispatcher forced it there, not
// because a fresh DNS lookup happened to find it.
test('pinnedDispatcher forces a fetch to the pinned address regardless of what the hostname would otherwise resolve to', async () => {
	const http = await import('node:http');
	const server = http.createServer((_req, res) => res.end('pinned-ok'));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('unexpected server address');
		const { fetch: undiciFetch } = await import('undici');
		const res = await undiciFetch(`http://this-hostname-does-not-resolve.invalid.example:${address.port}/`, {
			dispatcher: pinnedDispatcher(['127.0.0.1'])
		});
		assert.equal(await res.text(), 'pinned-ok');
	} finally {
		server.close();
	}
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
