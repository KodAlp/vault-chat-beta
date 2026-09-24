import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	isPdfBytes,
	validateLinkUrl,
	assertPublicHost,
	pinnedDispatcher,
	loadImportedUrls,
	sourceNameFromUrl,
	isYoutubeUrl,
	describeError,
	nextRedirectTarget,
	pdfContentTypeMismatch,
	fetchWithCap,
	rewriteArxivAbsToPdf,
	extractPdfLinks,
	isAllowedByRobots,
	politeDelay,
	isTransientFetchError,
	fetchWithRetry
} from './link-import';

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

test('sourceNameFromUrl uses the last path segment, percent-decoded', () => {
	assert.equal(sourceNameFromUrl(new URL('https://example.com/papers/cooley-tukey-fft.pdf')), 'cooley-tukey-fft.pdf');
	assert.equal(sourceNameFromUrl(new URL('https://example.com/notes/some%20paper.pdf')), 'some paper.pdf');
});

test('sourceNameFromUrl falls back to the hostname when the path is empty or bare', () => {
	assert.equal(sourceNameFromUrl(new URL('https://example.com')), 'example.com');
	assert.equal(sourceNameFromUrl(new URL('https://example.com/')), 'example.com');
});

test('sourceNameFromUrl uses the raw segment verbatim on malformed percent-encoding rather than throwing', () => {
	assert.equal(sourceNameFromUrl(new URL('https://example.com/a%zzpage')), 'a%zzpage');
});

test('isYoutubeUrl recognizes watch/shorts/youtu.be links, rejects everything else', () => {
	assert.equal(isYoutubeUrl(new URL('https://www.youtube.com/watch?v=abc123')), true);
	assert.equal(isYoutubeUrl(new URL('https://youtube.com/watch?v=abc123')), true);
	assert.equal(isYoutubeUrl(new URL('https://youtube.com/shorts/abc123')), true);
	assert.equal(isYoutubeUrl(new URL('https://youtu.be/abc123')), true);
	// #17: a channel/playlist page, or a lookalike domain, is not a video —
	// only the shapes yt-dlp can actually fetch a transcript from route here.
	assert.equal(isYoutubeUrl(new URL('https://www.youtube.com/@somechannel')), false);
	assert.equal(isYoutubeUrl(new URL('https://example.com/watch?v=abc123')), false);
	assert.equal(isYoutubeUrl(new URL('https://notyoutube.com.evil.example/watch?v=abc')), false);
});

test('describeError appends cause.code when present, e.g. a TLS chain failure', () => {
	const err = Object.assign(new Error('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
	assert.equal(describeError(err, 'fallback'), 'fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)');
});

test('describeError returns the bare message when there is no cause.code', () => {
	assert.equal(describeError(new Error('plain failure'), 'fallback'), 'plain failure');
	assert.equal(describeError(Object.assign(new Error('x'), { cause: 'not an object' }), 'fallback'), 'x');
});

test('describeError falls back for a non-Error throw', () => {
	assert.equal(describeError('a string was thrown', 'fallback'), 'fallback');
	assert.equal(describeError(undefined, 'fallback'), 'fallback');
});

test('nextRedirectTarget returns null for a non-redirect status, the loop must stop there', () => {
	assert.equal(nextRedirectTarget(new URL('https://a.example'), 200, null), null);
	assert.equal(nextRedirectTarget(new URL('https://a.example'), 404, null), null);
	assert.equal(nextRedirectTarget(new URL('https://a.example'), 500, '/somewhere'), null);
});

test('nextRedirectTarget resolves a relative Location against the current URL', () => {
	const next = nextRedirectTarget(new URL('https://a.example/dir/page'), 302, '../other');
	assert.equal(next?.href, 'https://a.example/other');
});

test('nextRedirectTarget resolves an absolute Location to a different host', () => {
	const next = nextRedirectTarget(new URL('https://a.example/x'), 301, 'https://b.example/y');
	assert.equal(next?.href, 'https://b.example/y');
});

test('nextRedirectTarget rejects a redirect with no Location header', () => {
	assert.throws(() => nextRedirectTarget(new URL('https://a.example'), 302, null), /Yönlendirme hedefsiz/);
});

test('nextRedirectTarget rejects an unparseable Location', () => {
	// "http://[" is invalid IPv6-literal syntax, not just a relative path —
	// new URL() throws on it even with a base, unlike a merely-odd relative path.
	assert.throws(() => nextRedirectTarget(new URL('https://a.example'), 302, 'http://['), /Geçersiz yönlendirme hedefi/);
});

test('nextRedirectTarget rejects a redirect to a non-http(s) scheme', () => {
	// #S15-style: a 302 to file:/data: must be rejected outright, not
	// followed and not silently treated as a dead end either.
	assert.throws(() => nextRedirectTarget(new URL('https://a.example'), 302, 'file:///etc/passwd'), /Desteklenmeyen yönlendirme protokolü/);
	assert.throws(() => nextRedirectTarget(new URL('https://a.example'), 302, 'javascript:alert(1)'), /Desteklenmeyen yönlendirme protokolü/);
});

test('pdfContentTypeMismatch flags a .pdf URL that did not come back as a real PDF', () => {
	assert.equal(pdfContentTypeMismatch(new URL('https://a.example/paper.pdf'), false), true);
	assert.equal(pdfContentTypeMismatch(new URL('https://a.example/paper.pdf?x=1'), false), true);
	assert.equal(pdfContentTypeMismatch(new URL('https://a.example/paper.pdf#frag'), false), true);
});

test('pdfContentTypeMismatch is silent when the bytes match, or the URL never promised a PDF', () => {
	assert.equal(pdfContentTypeMismatch(new URL('https://a.example/paper.pdf'), true), false);
	assert.equal(pdfContentTypeMismatch(new URL('https://a.example/page.html'), false), false);
	assert.equal(pdfContentTypeMismatch(new URL('https://a.example/download?id=1'), false), false);
});

test('fetchWithCap rejects a loopback/private target before ever sending a request — the SSRF check cannot be routed around by calling it directly', async () => {
	await assert.rejects(fetchWithCap(new URL('http://127.0.0.1:1/x')), /Yerel\/özel ağ/);
	await assert.rejects(fetchWithCap(new URL('http://[::ffff:127.0.0.1]:1/x')), /Yerel\/özel ağ/);
});

test('rewriteArxivAbsToPdf rewrites the abstract page path to the PDF path, preserving the id/version', () => {
	assert.equal(rewriteArxivAbsToPdf(new URL('https://arxiv.org/abs/1706.03762')).href, 'https://arxiv.org/pdf/1706.03762');
	assert.equal(rewriteArxivAbsToPdf(new URL('https://arxiv.org/abs/1706.03762v2')).href, 'https://arxiv.org/pdf/1706.03762v2');
	assert.equal(rewriteArxivAbsToPdf(new URL('https://export.arxiv.org/abs/1706.03762')).href, 'https://export.arxiv.org/pdf/1706.03762');
});

test('rewriteArxivAbsToPdf leaves non-arXiv hosts and non-/abs/ paths untouched', () => {
	assert.equal(rewriteArxivAbsToPdf(new URL('https://example.com/abs/1706.03762')).href, 'https://example.com/abs/1706.03762');
	assert.equal(rewriteArxivAbsToPdf(new URL('https://arxiv.org/pdf/1706.03762')).href, 'https://arxiv.org/pdf/1706.03762');
	assert.equal(rewriteArxivAbsToPdf(new URL('https://notarxiv.org.evil.example/abs/1')).href, 'https://notarxiv.org.evil.example/abs/1');
});

// Real shape measured 2026-09-24 against MIT OCW's own "Download course
// materials" page (the one page of a course site that IS server-rendered —
// its regular lecture-notes/readings pages are a client-rendered SPA with
// no static links at all, confirmed against three real course pages).
test('extractPdfLinks finds same-origin PDF links and prefers real anchor text over a size badge', () => {
	const html = `
		<a href="/courses/x/lec01.pdf">Lecture 1 Notes</a>
		<a href="/courses/x/hash123_final.pdf">pdf 478 kB</a>
		<a href="https://cdn.example.com/other.pdf">Off-site PDF</a>
		<a href="/courses/x/readings/">Not a PDF</a>
	`;
	const links = extractPdfLinks(html, new URL('https://ocw.example/courses/x/download/'));
	assert.deepEqual(
		links.map((l) => l.url),
		['https://ocw.example/courses/x/lec01.pdf', 'https://ocw.example/courses/x/hash123_final.pdf']
	);
	assert.equal(links[0].text, 'Lecture 1 Notes');
	// "pdf 478 kB" has no token >=3 chars that isn't noise/a number — falls
	// back to the URL's own filename instead of a useless label.
	assert.equal(links[1].text, 'hash123_final.pdf');
});

test('extractPdfLinks dedupes repeated links and ignores malformed hrefs', () => {
	const html = `
		<a href="/a.pdf">A</a>
		<a href="/a.pdf">A again</a>
		<a href="javascript:alert(1)">evil</a>
		<a href="not a url at all\x00">broken</a>
	`;
	const links = extractPdfLinks(html, new URL('https://example.com/'));
	assert.deepEqual(
		links.map((l) => l.url),
		['https://example.com/a.pdf']
	);
});

test('isAllowedByRobots allows everything when robots.txt is missing/unreachable', () => {
	assert.equal(isAllowedByRobots(new URL('https://example.com/private/x'), null), true);
});

test('isAllowedByRobots respects Disallow for the matched user-agent', () => {
	const robotsTxt = ['User-agent: *', 'Disallow: /private/'].join('\n');
	assert.equal(isAllowedByRobots(new URL('https://example.com/private/x'), robotsTxt), false);
	assert.equal(isAllowedByRobots(new URL('https://example.com/public/x'), robotsTxt), true);
});

test('politeDelay waits out the remainder of the courtesy window since the last fetch to the same host, then updates it', async () => {
	const registry = new Map<string, number>();
	let clock = 1000;
	const now = () => clock;
	const waits: number[] = [];
	const sleep = async (ms: number) => {
		waits.push(ms);
		clock += ms;
	};

	registry.set('example.com', 1000);
	clock = 1400; // only 400ms elapsed, courtesy window is 1000ms
	await politeDelay('example.com', registry, now, sleep);
	assert.deepEqual(waits, [600]);
	assert.equal(registry.get('example.com'), 2000);
});

test('politeDelay does not wait for a host that has never been fetched, or one whose window already elapsed', async () => {
	const registry = new Map<string, number>();
	const sleep = async () => {
		throw new Error('should not sleep');
	};
	await politeDelay('never-fetched.example', registry, () => 5000, sleep);

	registry.set('elapsed.example', 0);
	await politeDelay('elapsed.example', registry, () => 5000, sleep);
});

test('isTransientFetchError recognizes only the curated transport-level codes', () => {
	assert.equal(isTransientFetchError(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } })), true);
	assert.equal(isTransientFetchError(Object.assign(new Error('x'), { cause: { code: 'ETIMEDOUT' } })), true);
	assert.equal(isTransientFetchError(new Error('İstek başarısız: 404')), false);
	assert.equal(isTransientFetchError(new Error('Yerel/özel ağ adresine erişim reddedildi: x')), false);
	assert.equal(isTransientFetchError('not an error'), false);
});

test('fetchWithRetry retries once on a transient error then succeeds, without a real sleep', async () => {
	let attempt = 0;
	const flaky = async () => {
		attempt++;
		if (attempt === 1) throw Object.assign(new Error('boom'), { cause: { code: 'ECONNRESET' } });
		return Buffer.from('ok');
	};
	const waits: number[] = [];
	const sleep = async (ms: number) => {
		waits.push(ms);
	};
	const result = await fetchWithRetry(new URL('https://example.com/x'), 2, flaky, sleep);
	assert.equal(result.toString(), 'ok');
	assert.equal(attempt, 2);
	assert.deepEqual(waits, [1000]);
});

test('fetchWithRetry does not retry a permanent (non-transient) failure', async () => {
	let attempt = 0;
	const alwaysNotFound = async () => {
		attempt++;
		throw new Error('İstek başarısız: 404');
	};
	await assert.rejects(fetchWithRetry(new URL('https://example.com/x'), 3, alwaysNotFound), /404/);
	assert.equal(attempt, 1);
});

test('fetchWithRetry gives up after the attempt budget even for a transient error', async () => {
	let attempt = 0;
	const alwaysFlaky = async () => {
		attempt++;
		throw Object.assign(new Error('boom'), { cause: { code: 'ETIMEDOUT' } });
	};
	await assert.rejects(fetchWithRetry(new URL('https://example.com/x'), 2, alwaysFlaky, async () => {}), /boom/);
	assert.equal(attempt, 2);
});

test('fetchWithRetry, with its real default fetcher, still rejects an SSRF target immediately', async () => {
	await assert.rejects(fetchWithRetry(new URL('http://127.0.0.1:1/x')), /Yerel\/özel ağ/);
});
