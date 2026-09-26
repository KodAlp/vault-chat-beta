import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import robotsParser from 'robots-parser';
import { MAX_UPLOAD_BYTES } from './library';
import { AppError } from './app-error';

/** Shared by every FILE_TOO_LARGE site (single upload, batch item, link
 * fetch cap) so the catalog's {limitMb} always matches the real cap. */
const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

/** First bytes, not Content-Type — servers routinely send a wrong/missing
 * header, and the magic signature is what actually determines whether
 * enqueueConversion (PDF) or enqueueWebExtract (HTML) can handle the bytes. */
export function isPdfBytes(buf: Buffer): boolean {
	return buf.subarray(0, 5).toString('ascii') === '%PDF-';
}

/** Aşama 6 #17: a YouTube link pasted into the generic links importer used
 * to be fetched as a plain web page — trafilatura extracting whatever
 * boilerplate/JS-shell HTML youtube.com serves, never the actual video
 * transcript. Shared with api/import/youtube/+server.ts's own check so the
 * two can't drift apart. */
export const YOUTUBE_URL = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?|shorts\/)|youtu\.be\/)/i;

export function isYoutubeUrl(url: URL): boolean {
	return YOUTUBE_URL.test(url.href);
}

/** #19: a generic Error#message from a TLS/DNS failure is often just
 * "fetch failed" — the actionable detail (CERT_HAS_EXPIRED,
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE, ENOTFOUND, ...) lives one level down, on
 * Node's/undici's `cause`, which Error#message never includes. */
export function describeError(err: unknown, fallback: string): string {
	if (!(err instanceof Error)) return fallback;
	const cause = (err as Error & { cause?: unknown }).cause;
	const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : undefined;
	return code ? `${err.message} (${code})` : err.message;
}

/** Rejects anything that isn't a plain http(s) URL — no file:/javascript:/
 * data: etc. Throws an AppError rather than returning null, so route code
 * can treat it exactly like any other per-link failure via toCodedError(). */
export function validateLinkUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new AppError('LINK_INVALID', { url: raw });
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new AppError('LINK_PROTOCOL_UNSUPPORTED', { protocol: url.protocol });
	}
	return url;
}

/** A stand-in filename for convert.py's --source-name (E5/K2-5) — a link
 * has no local file to name, but a PDF's own URL path is usually
 * descriptive ("/papers/cooley-tukey-fft.pdf"), which is exactly what a
 * `source_file` frontmatter field and a title fallback both want instead of
 * the staged "original.pdf" every link gets written under. Falls back to
 * the hostname when the path is empty or just "/" (a bare domain link, or a
 * download endpoint like "/download?id=123" with nothing file-shaped in it). */
export function sourceNameFromUrl(url: URL): string {
	const lastSegment = url.pathname.split('/').filter(Boolean).pop();
	if (!lastSegment) return url.hostname;
	try {
		return decodeURIComponent(lastSegment);
	} catch {
		return lastSegment; // malformed percent-encoding — use it verbatim rather than throw
	}
}

/**
 * Blocked ranges, checked via node:net's built-in BlockList rather than
 * hand-rolled bit masks (2026-09-23 rewrite — the hand-rolled version had
 * two independent gaps, both measured against real bypass attempts):
 *
 * 1. BlockList.check() understands IPv4-mapped IPv6 syntax natively
 *    (`::ffff:127.0.0.1` AND the equivalent hex form `::ffff:7f00:1`) and
 *    tests it against the IPv4 subnets below — the old isPrivateV6() only
 *    matched literal string prefixes (`::1`, `fc`, `fd`, `fe80`) and had no
 *    idea `::ffff:127.0.0.1` *was* 127.0.0.1. That gap was proven live: an
 *    isolated test server bound only to 127.0.0.1 was reachable and its
 *    response ("Wi-Fi şifresi: ...") was converted and written into the vault.
 * 2. The IPv4 range list was missing three: 198.18.0.0/15 (benchmark —
 *    RFC 2544), 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved). The IPv6
 *    list was missing 64:ff9b::/96 (the well-known NAT64 prefix — BlockList
 *    does NOT auto-decode this one the way it does ::ffff:, so the whole
 *    prefix is blocked outright rather than attempting to decode-then-check
 *    its embedded address) and fec0::/10 (deprecated IPv6 site-local,
 *    still occasionally seen). fc00::/7 replaces the old fc/fd string-prefix
 *    check with the actual ULA CIDR block (equivalent, just expressed as a
 *    proper subnet instead of two string prefixes).
 */
const BLOCKED_HOSTS = new net.BlockList();
for (const [base, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['224.0.0.0', 4],
	['240.0.0.0', 4]
] as const) {
	BLOCKED_HOSTS.addSubnet(base, prefix, 'ipv4');
}
for (const [base, prefix] of [
	['::1', 128],
	['::', 128],
	['fc00::', 7],
	['fe80::', 10],
	['fec0::', 10],
	['64:ff9b::', 96]
] as const) {
	BLOCKED_HOSTS.addSubnet(base, prefix, 'ipv6');
}

/** True for a blocked address, or for anything that isn't a well-formed IP
 * at all (net.isIP returns 0) — an unparseable literal is refused rather
 * than let through on the assumption that it must be safe. */
function isBlockedAddress(ip: string): boolean {
	const family = net.isIP(ip);
	if (family === 4) return BLOCKED_HOSTS.check(ip, 'ipv4');
	if (family === 6) return BLOCKED_HOSTS.check(ip, 'ipv6');
	return true;
}

/**
 * SSRF guard: resolves the URL's hostname and rejects loopback/private/
 * link-local targets. This is a locally-run, single-user app, but the user
 * pastes links from arbitrary sources — a malicious/compromised link list
 * could still point at another local service (router admin panel, another
 * app on localhost) and have its response smuggled into the vault.
 *
 * Returns the validated addresses so a caller can pin its actual connection
 * to exactly these — fetch() resolving DNS again on its own, after this
 * check passed, would leave a window for DNS rebinding (the name resolves
 * to a public IP here, then to a private one by the time the real connect
 * happens). See fetchWithCap in api/import/links/+server.ts, the only
 * caller that pins today.
 *
 * Node's fetch follows redirects automatically by default, so a caller that
 * doesn't override that must re-check the *final* response.url with this
 * same function after the fetch completes — but fetchWithCap now follows
 * redirects manually instead, checking (and pinning) every hop, which also
 * closes the "only the last hop was checked" gap the old comment here
 * warned about.
 */
type Resolver = (hostname: string) => Promise<string[]>;
const defaultResolve4: Resolver = dns.resolve4;
const defaultResolve6: Resolver = dns.resolve6;

export async function assertPublicHost(
	url: URL,
	resolve4: Resolver = defaultResolve4,
	resolve6: Resolver = defaultResolve6
): Promise<string[]> {
	// URL.hostname keeps the brackets for an IPv6 literal ("[::1]") — net.isIP
	// only recognizes the bare address form.
	const hostname = url.hostname.replace(/^\[|\]$/g, '');
	if (net.isIP(hostname)) {
		if (isBlockedAddress(hostname)) {
			throw new AppError('LINK_PRIVATE_NETWORK', { host: hostname });
		}
		return [hostname];
	}
	const addrs: string[] = [];
	try {
		addrs.push(...(await resolve4(hostname)));
	} catch {
		// no A record — fall through to AAAA
	}
	try {
		addrs.push(...(await resolve6(hostname)));
	} catch {
		// no AAAA record either
	}
	if (addrs.length === 0) {
		throw new AppError('LINK_DNS_FAILED', { host: hostname });
	}
	for (const addr of addrs) {
		if (isBlockedAddress(addr)) {
			throw new AppError('LINK_PRIVATE_NETWORK', { host: hostname, addr });
		}
	}
	return addrs;
}

/**
 * Builds a fetch `dispatcher` (undici's per-request Agent override) whose
 * DNS lookup always answers with exactly `addrs` — the ones assertPublicHost
 * already validated — instead of letting undici resolve the hostname again
 * at connect time. That second resolution is the DNS-rebinding gap: an
 * attacker's name server can legitimately answer with a public IP for the
 * validation lookup and a private one moments later for the real connect,
 * with nothing in between to catch the swap. Pinning removes the second
 * lookup entirely, so there is nothing left to rebind.
 *
 * `undici` is a real (if transitive-until-now) dependency — see
 * package.json — not Node's global fetch reaching for a module that isn't
 * actually installed; Node 22 does not yet expose `node:undici` as a
 * built-in specifier.
 *
 * A no-op, harmlessly, when the URL's host is already a literal IP: undici
 * (like net.connect generally) never calls `lookup` for a literal address —
 * there is no DNS step to pin in the first place, since there was never a
 * name for a rebinding attack to swap out from under. Confirmed empirically
 * while writing this: a dispatcher built from this function did not alter
 * where a literal-IP request connected.
 */
export function pinnedDispatcher(addrs: string[]): Agent {
	return new Agent({
		connect: {
			lookup: (_hostname, options, callback) => {
				const family = (options as { family?: number }).family;
				const filtered = family ? addrs.filter((a) => net.isIP(a) === family) : addrs;
				const chosen = filtered.length > 0 ? filtered : addrs;
				if ((options as { all?: boolean }).all) {
					callback(
						null,
						chosen.map((address) => ({ address, family: net.isIP(address) as 4 | 6 }))
					);
					return;
				}
				callback(null, chosen[0], net.isIP(chosen[0]));
			}
		}
	});
}

/**
 * URL-keyed equivalent of importObsidian.ts's loadLastKnownHashes — only
 * successfully-imported URLs count as "already done", so a link that
 * previously failed stays retryable on the next run of the same list.
 */
export function loadImportedUrls(logPath: string): Set<string> {
	const known = new Set<string>();
	if (!fs.existsSync(logPath)) return known;
	const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as { sourceUrl?: string; status?: string };
			if (entry.sourceUrl && (entry.status === 'converted' || entry.status === 'needs_review')) {
				known.add(entry.sourceUrl);
			}
		} catch {
			// malformed line — skip, don't let one bad entry break the whole scan
		}
	}
	return known;
}

const MAX_REDIRECTS = 5;
const LINK_FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; vault-chat-import/1.0)';

/** Pure redirect-hop decision, pulled out of fetchWithCap's loop so the
 * actual bug-prone part — this is exactly where the original "only the
 * final hop was checked" SSRF gap lived — is unit-testable without a live
 * server (fetchWithCap's own assertPublicHost call can't be exercised
 * against a real local target: 127.0.0.0/8 is unconditionally blocked, by
 * design, regardless of how the hostname resolves).
 *
 * Returns null when `status` isn't a redirect (the caller should treat the
 * response as final); throws for a redirect this code can't safely follow
 * (no Location, unparseable, or a non-http(s) target — the exact three
 * ways a redirect could smuggle a request somewhere assertPublicHost never
 * gets to check). */
export function nextRedirectTarget(current: URL, status: number, location: string | null): URL | null {
	if (status < 300 || status >= 400) return null;
	if (!location) throw new AppError('LINK_REDIRECT_INVALID', { detail: `no Location header (${status})` });
	let next: URL;
	try {
		next = new URL(location, current);
	} catch {
		throw new AppError('LINK_REDIRECT_INVALID', { detail: location });
	}
	if (next.protocol !== 'http:' && next.protocol !== 'https:') {
		throw new AppError('LINK_REDIRECT_INVALID', { detail: next.protocol });
	}
	return next;
}

/**
 * Streamed read with a hard byte cap — Content-Length can be missing or
 * wrong, so the cap is enforced against bytes actually received, not the
 * header.
 *
 * Redirects are followed *manually* (`redirect: 'manual'`), not by fetch
 * itself: fetch's own automatic following only ever leaves the *final*
 * `res.url` for a caller to check afterward, so a malicious/compromised
 * link could 302 through a public first hop straight into a private
 * service and only the last, already-public hop would ever be validated
 * (a real chain proved this: the first hop's `assertPublicHost` call
 * passed, the actual private-service response still got fetched). Every
 * hop is now checked — and pinned to the address that check validated,
 * via `pinnedDispatcher` — before it is followed.
 *
 * One deadline for the whole chain, not one per hop: a hop-by-hop timeout
 * would let a redirect chain tie up sharedJobMutex for
 * `LINK_FETCH_TIMEOUT_MS * MAX_REDIRECTS`, several minutes, instead of the
 * single request's usual 30s budget.
 *
 * Moved here from api/import/links/+server.ts (Aşama 6, #33) so it can be
 * unit-tested against a real local HTTP server — route files in this repo
 * are never imported by a test, only $lib/server/*.ts is.
 */
export async function fetchWithCap(url: URL): Promise<Buffer> {
	const deadline = Date.now() + LINK_FETCH_TIMEOUT_MS;
	let current = url;

	for (let hop = 0; ; hop++) {
		if (hop > MAX_REDIRECTS) throw new AppError('LINK_TOO_MANY_REDIRECTS', { max: MAX_REDIRECTS });
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new AppError('LINK_TIMEOUT');

		const addrs = await assertPublicHost(current);
		const res = await undiciFetch(current.href, {
			redirect: 'manual',
			signal: AbortSignal.timeout(remaining),
			headers: { 'user-agent': USER_AGENT },
			dispatcher: pinnedDispatcher(addrs)
		});

		const next = nextRedirectTarget(current, res.status, res.headers.get('location'));
		if (next) {
			current = next;
			continue;
		}

		if (!res.ok) throw new AppError('LINK_HTTP_FAILED', { status: res.status });
		if (!res.body) return Buffer.alloc(0);

		const reader = res.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_UPLOAD_BYTES) {
				await reader.cancel();
				throw new AppError('FILE_TOO_LARGE', { limitMb: MAX_UPLOAD_MB });
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks);
	}
}

/** #10: a URL ending in .pdf that comes back as something other than a real
 * PDF (no %PDF- magic signature) usually means a redirect chain landed on
 * an HTML error/login page, not the expected document — this says so,
 * rather than the caller silently importing that page as if it were the
 * PDF it asked for. */
export function pdfContentTypeMismatch(url: URL, isPdf: boolean): boolean {
	return /\.pdf(?:[?#]|$)/i.test(url.pathname) && !isPdf;
}

/** Aşama 10 #4 (isteğe bağlı, cheap win): arXiv's abstract page and its PDF
 * live at predictable sibling paths — a user pasting the /abs/ page (the
 * one arXiv actually links from search results and citations) would
 * otherwise get an HTML abstract-only page imported instead of the paper.
 * Version suffixes (v1, v2, ...) are preserved as-is; arXiv serves the PDF
 * at the same version path. No-op for anything that isn't this exact shape
 * (old-style archive IDs like hep-th/9901001 included — left alone rather
 * than guessed at). */
const ARXIV_ABS = /^\/abs\/([\w.-]+)$/;

export function rewriteArxivAbsToPdf(url: URL): URL {
	if (!/(^|\.)arxiv\.org$/i.test(url.hostname)) return url;
	const m = ARXIV_ABS.exec(url.pathname);
	if (!m) return url;
	const next = new URL(url.href);
	next.pathname = `/pdf/${m[1]}`;
	return next;
}

/**
 * Aşama 10 #1: OCW-style course sites (and multi-page sites generally)
 * often list several readings on one page. "List, then let the user
 * choose" (D2 — this app's hardware budgets one fetch/convert per link
 * tightly; crawling every linked page automatically would multiply that),
 * not "fetch everything this page links to". Same-origin only, one page
 * deep — no recursive crawling, no following links found on THOSE pages.
 *
 * Measured against real pages (2026-09-24): MIT OCW's regular course
 * pages (lecture-notes, readings, ...) are client-rendered — the PDF links
 * genuinely are not present in the static HTML this function receives, no
 * regex or parser fix changes that (D1: no headless browser in this
 * pipeline). Its per-course "Download course materials" page
 * (.../download/) is the one exception: server-rendered, lists every PDF
 * on the course with a real href. That's the page this feature is for;
 * the dialog's help text says so rather than implying it works on any OCW
 * URL.
 *
 * Anchor parsing is a small hand-rolled regex, not a full HTML parser —
 * consistent with this file's SSRF BlockList/nextRedirectTarget choices:
 * this only needs href+text out of <a> tags, not a DOM.
 */
const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const NOISE_TOKEN = /^(pdf|zip|doc|docx|xls|xlsx|ppt|pptx|kb|mb|gb|byte|bytes|download|indir)$/i;

/** Anchor inner text is often just a download-size badge ("pdf 478 kB"),
 * not a real title — filtered down to tokens that look like actual words
 * before falling back to the URL's filename (sourceNameFromUrl), which is
 * usually more descriptive than a size badge even when it isn't pretty. */
function linkLabel(innerHtml: string, url: URL): string {
	const raw = innerHtml
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	// Kept whole (not rebuilt token-by-token) once it's judged worth
	// keeping at all — a lone "1" in "Lecture 1 Notes" is part of a real
	// title, not noise, so filtering per-token would wrongly drop it; only
	// the ALL-noise/size-badge case ("pdf 478 kB", no qualifying word
	// anywhere in it) should fall back to the filename.
	const hasRealWord = raw.split(' ').some((tok) => {
		const word = tok.replace(/[.,()]/g, '');
		return word.length >= 3 && !NOISE_TOKEN.test(word) && !/^\d+$/.test(word);
	});
	return hasRealWord ? raw : sourceNameFromUrl(url);
}

export interface DiscoveredPdfLink {
	url: string;
	text: string;
}

export function extractPdfLinks(html: string, baseUrl: URL): DiscoveredPdfLink[] {
	const seen = new Set<string>();
	const links: DiscoveredPdfLink[] = [];
	let m: RegExpExecArray | null;
	ANCHOR_RE.lastIndex = 0;
	while ((m = ANCHOR_RE.exec(html))) {
		const [, hrefRaw, innerHtml] = m;
		let resolved: URL;
		try {
			resolved = new URL(hrefRaw, baseUrl);
		} catch {
			continue;
		}
		if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
		if (resolved.hostname !== baseUrl.hostname) continue;
		if (!/\.pdf(?:[?#]|$)/i.test(resolved.pathname)) continue;
		if (seen.has(resolved.href)) continue;
		seen.add(resolved.href);
		links.push({ url: resolved.href, text: linkLabel(innerHtml, resolved) });
	}
	return links;
}

/**
 * Aşama 10 #3: robots.txt is fetched once per origin per run (cached in
 * `cache`, keyed by origin) rather than once per link, so a batch of
 * several links from the same course site doesn't triple its request
 * count over robots.txt alone. A missing/unreachable robots.txt means "no
 * restrictions" per the spec — same as every real crawler's behavior — not
 * a reason to block the import.
 */
const defaultRobotsCache = new Map<string, Promise<string | null>>();

export async function fetchRobotsTxt(origin: string, cache: Map<string, Promise<string | null>> = defaultRobotsCache): Promise<string | null> {
	let pending = cache.get(origin);
	if (!pending) {
		pending = fetchWithCap(new URL('/robots.txt', origin))
			.then((buf) => buf.toString('utf-8'))
			.catch(() => null);
		cache.set(origin, pending);
	}
	return pending;
}

export function isAllowedByRobots(url: URL, robotsTxt: string | null, userAgent: string = USER_AGENT): boolean {
	if (robotsTxt === null) return true;
	const robots = robotsParser(`${url.origin}/robots.txt`, robotsTxt);
	// isAllowed() returns `undefined` when robots.txt says nothing usable
	// about this URL/agent — treated as allowed, same as a missing file.
	// Only an explicit `false` blocks.
	return robots.isAllowed(url.href, userAgent) !== false;
}

/**
 * Aşama 10 #3 (nezaket): don't fetch the same host back-to-back across a
 * batch of links without any gap between requests. Registry/clock/sleep
 * are injectable so tests don't have to actually wait a full second —
 * default state is shared across a whole process run (same reasoning as
 * defaultRobotsCache: politeness is a property of THIS app's outgoing
 * traffic to a host, not of one request).
 */
const COURTESY_DELAY_MS = 1000;
const defaultLastFetchByHost = new Map<string, number>();

export async function politeDelay(
	hostname: string,
	registry: Map<string, number> = defaultLastFetchByHost,
	now: () => number = Date.now,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<void> {
	const last = registry.get(hostname);
	const elapsed = last === undefined ? Infinity : now() - last;
	if (elapsed < COURTESY_DELAY_MS) {
		await sleep(COURTESY_DELAY_MS - elapsed);
	}
	registry.set(hostname, now());
}

const TRANSIENT_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

/** Only a curated set of transport-level failure codes are retried — a 404,
 * a rejected SSRF check, or a "too large" cap are permanent outcomes that a
 * retry cannot change, so retrying them would just add latency for a link
 * that was always going to fail. */
export function isTransientFetchError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const cause = (err as Error & { cause?: unknown }).cause;
	const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : undefined;
	return code !== undefined && TRANSIENT_ERROR_CODES.has(code);
}

/**
 * Aşama 10 #3 (sınırlı yeniden deneme): one retry, only for the transient
 * codes above, with a short backoff — not a general-purpose retry loop.
 * `sleep` is injectable for tests.
 */
export async function fetchWithRetry(
	url: URL,
	attempts = 2,
	fetcher: (url: URL) => Promise<Buffer> = fetchWithCap,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<Buffer> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fetcher(url);
		} catch (err) {
			if (attempt >= attempts || !isTransientFetchError(err)) throw err;
			await sleep(1000 * attempt);
		}
	}
}
