import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { MAX_UPLOAD_BYTES } from './library';

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
 * data: etc. Throws a readable Turkish message rather than returning
 * null, so route code can treat it exactly like any other per-link failure. */
export function validateLinkUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error(`Geçersiz bağlantı: ${raw}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`Desteklenmeyen protokol: ${url.protocol}`);
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
			throw new Error(`Yerel/özel ağ adresine erişim reddedildi: ${hostname}`);
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
		throw new Error(`Alan adı çözümlenemedi: ${hostname}`);
	}
	for (const addr of addrs) {
		if (isBlockedAddress(addr)) {
			throw new Error(`Yerel/özel ağ adresine erişim reddedildi: ${hostname} (${addr})`);
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
	if (!location) throw new Error(`Yönlendirme hedefsiz (${status})`);
	let next: URL;
	try {
		next = new URL(location, current);
	} catch {
		throw new Error(`Geçersiz yönlendirme hedefi: ${location}`);
	}
	if (next.protocol !== 'http:' && next.protocol !== 'https:') {
		throw new Error(`Desteklenmeyen yönlendirme protokolü: ${next.protocol}`);
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
		if (hop > MAX_REDIRECTS) throw new Error(`Çok fazla yönlendirme (>${MAX_REDIRECTS})`);
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error('İstek zaman aşımına uğradı');

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

		if (!res.ok) throw new Error(`İstek başarısız: ${res.status}`);
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
				throw new Error('Dosya çok büyük (100MB sınırı)');
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
