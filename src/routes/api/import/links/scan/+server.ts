import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	validateLinkUrl,
	assertPublicHost,
	isPdfBytes,
	fetchRobotsTxt,
	isAllowedByRobots,
	politeDelay,
	fetchWithRetry,
	extractPdfLinks,
	describeError
} from '$lib/server/link-import';

/**
 * Aşama 10 #1: "list this page's PDF links, then let the user choose" —
 * not a crawl. Reads the given page (SSRF-checked, robots.txt-checked,
 * courtesy-delayed, one retry on a transient failure — same guards the
 * main /api/import/links POST applies per link) and returns same-origin
 * PDF hrefs found in its static HTML. Nothing is fetched or staged beyond
 * this one page; the returned links still go through the normal
 * POST /api/import/links flow (and its own onay/staging step) to actually
 * import anything.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { url?: unknown };
	const raw = typeof body.url === 'string' ? body.url : '';
	if (!raw.trim()) error(400, 'Bir sayfa adresi gerekli');

	let url: URL;
	try {
		url = validateLinkUrl(raw);
	} catch (err) {
		error(400, describeError(err, 'Geçersiz bağlantı'));
	}

	try {
		await assertPublicHost(url);
	} catch (err) {
		error(400, describeError(err, 'Geçersiz bağlantı'));
	}

	const robotsTxt = await fetchRobotsTxt(url.origin);
	if (!isAllowedByRobots(url, robotsTxt)) {
		error(403, 'robots.txt bu sayfayı taramaya izin vermiyor');
	}

	await politeDelay(url.hostname);

	let bytes: Buffer;
	try {
		bytes = await fetchWithRetry(url);
	} catch (err) {
		error(502, describeError(err, 'Sayfa alınamadı'));
	}

	if (isPdfBytes(bytes)) {
		error(400, 'Bu adres zaten bir PDF — taramaya gerek yok, doğrudan bağlantı listesine ekleyin');
	}

	const html = bytes.toString('utf-8');
	const links = extractPdfLinks(html, url);
	return json({ links });
};
