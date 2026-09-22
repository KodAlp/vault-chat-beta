import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';

/** First bytes, not Content-Type — servers routinely send a wrong/missing
 * header, and the magic signature is what actually determines whether
 * enqueueConversion (PDF) or enqueueWebExtract (HTML) can handle the bytes. */
export function isPdfBytes(buf: Buffer): boolean {
	return buf.subarray(0, 5).toString('ascii') === '%PDF-';
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

const PRIVATE_V4_RANGES: [string, number][] = [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.168.0.0', 16]
];

function ipv4ToInt(ip: string): number {
	return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isPrivateV4(ip: string): boolean {
	const ipInt = ipv4ToInt(ip);
	return PRIVATE_V4_RANGES.some(([base, bits]) => {
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		return (ipInt & mask) === (ipv4ToInt(base) & mask);
	});
}

function isPrivateV6(ip: string): boolean {
	const lower = ip.toLowerCase();
	return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

/**
 * SSRF guard: resolves the URL's hostname and rejects loopback/private/
 * link-local targets. This is a locally-run, single-user app, but the user
 * pastes links from arbitrary sources — a malicious/compromised link list
 * could still point at another local service (router admin panel, another
 * app on localhost) and have its response smuggled into the vault. Node's
 * fetch follows redirects automatically, so callers must re-check the
 * *final* response.url with this same function after the fetch completes,
 * not just the link as typed.
 */
type Resolver = (hostname: string) => Promise<string[]>;
const defaultResolve4: Resolver = dns.resolve4;
const defaultResolve6: Resolver = dns.resolve6;

export async function assertPublicHost(url: URL, resolve4: Resolver = defaultResolve4, resolve6: Resolver = defaultResolve6): Promise<void> {
	// URL.hostname keeps the brackets for an IPv6 literal ("[::1]") — net.isIP
	// only recognizes the bare address form.
	const hostname = url.hostname.replace(/^\[|\]$/g, '');
	if (net.isIP(hostname)) {
		if (net.isIP(hostname) === 4 ? isPrivateV4(hostname) : isPrivateV6(hostname)) {
			throw new Error(`Yerel/özel ağ adresine erişim reddedildi: ${hostname}`);
		}
		return;
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
		const isPrivate = net.isIP(addr) === 4 ? isPrivateV4(addr) : isPrivateV6(addr);
		if (isPrivate) {
			throw new Error(`Yerel/özel ağ adresine erişim reddedildi: ${hostname} (${addr})`);
		}
	}
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
