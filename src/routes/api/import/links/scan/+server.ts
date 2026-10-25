import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	validateLinkUrl,
	assertPublicHost,
	isPdfBytes,
	fetchRobotsTxt,
	isAllowedByRobots,
	politeDelay,
	fetchWithRetry,
	extractPdfLinks
} from '#lib/server/link-import.js';
import { AppError, fail, toCodedError } from '#lib/server/app-error.js';
import type { ErrorCode } from '#lib/errors.js';

/**
 * "List this page's PDF links, then let the user choose" —
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
	if (!raw.trim()) fail('VALIDATION_REQUIRED', { field: 'url' });

	let url: URL;
	try {
		url = validateLinkUrl(raw);
	} catch (err) {
		const c = toCodedError(err);
		fail(c.code as ErrorCode, c.params, err instanceof AppError ? err.status : 400);
	}

	try {
		await assertPublicHost(url);
	} catch (err) {
		const c = toCodedError(err);
		fail(c.code as ErrorCode, c.params, err instanceof AppError ? err.status : 400);
	}

	const robotsTxt = await fetchRobotsTxt(url.origin);
	if (!isAllowedByRobots(url, robotsTxt)) {
		fail('LINK_ROBOTS_DISALLOWED', undefined, 403);
	}

	await politeDelay(url.hostname);

	let bytes: Buffer;
	try {
		bytes = await fetchWithRetry(url);
	} catch (err) {
		const c = toCodedError(err);
		fail(c.code as ErrorCode, c.params, err instanceof AppError ? err.status : 502);
	}

	if (isPdfBytes(bytes)) {
		fail('LINK_ALREADY_PDF');
	}

	const html = bytes.toString('utf-8');
	const links = extractPdfLinks(html, url);
	return json({ links });
};
