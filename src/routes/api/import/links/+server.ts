import crypto from 'node:crypto';
import type { RequestHandler } from './$types';
import { validateLinkUrl, loadImportedUrls, rewriteArxivAbsToPdf } from '$lib/server/link-import';
import { stageUrl } from '$lib/server/stage-url';
import { importLogPath } from '$lib/server/library';
import { vaultFromId } from '$lib/server/requestVault';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import { fail, toCodedError } from '$lib/server/app-error';
import type { ImportEvent, ImportResultItem, ImportSummary } from '$lib/types';

const MAX_LINKS_PER_BATCH = 50;

/** Builds a 'failed' ImportResultItem from any caught error — an AppError
 * thrown deliberately by link-import.ts/convertQueue.ts/youtubeQueue.ts, or
 * a generic Error (an unwrapped fetch exception, e.g. a TLS failure) that
 * toCodedError() falls back to classifying as UNKNOWN with the raw message
 * as `detail`. `reason` is set to the code itself (not human text) — kept
 * for logs/back-compat; the UI renders via localizeError({code, params}). */
function failedItem(fileName: string, err: unknown): ImportResultItem {
	const coded = toCodedError(err);
	return { id: crypto.randomUUID(), fileName, status: 'failed', code: coded.code, params: coded.params, reason: coded.code };
}

/**
 * Küçük ilk dilim (Faz 15): PDF linkleri mevcut convert.py'ye, web sayfaları
 * yeni extract_web.py/trafilatura'ya gider. Sıralı (sharedJobMutex, batch
 * upload ile aynı desen). Güvenlik: assertPublicHost (SSRF), akış halinde
 * boyut sınırı (Content-Length'e güvenmeden), process timeout — bkz. plan.
 *
 * #10 (2026-09-23): her sonuç artık kütüphaneye doğrudan yazılmıyor —
 * dosya/YouTube yüklemesiyle aynı staging → onay adımından geçiyor
 * (/api/library/import/[id]/confirm, aynı rota, üç kaynak da paylaşıyor).
 * 'pending' durumundaki bir item importId+proposed+warnings taşır; arayüz
 * bunu onaylayana ya da iptal edene kadar kütüphaneye ya da import-log'a
 * hiçbir şey yazılmaz.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { links?: unknown; domain?: unknown; vault?: unknown };
	const domain = typeof body.domain === 'string' && body.domain.trim() ? body.domain.trim() : 'genel';
	const links = Array.isArray(body.links) ? body.links.filter((l): l is string => typeof l === 'string' && l.trim() !== '') : [];
	const v = vaultFromId(typeof body.vault === 'string' ? body.vault : null);

	if (links.length === 0) {
		fail('LINKS_MIN_ONE');
	}
	if (links.length > MAX_LINKS_PER_BATCH) {
		fail('LINKS_MAX', { max: MAX_LINKS_PER_BATCH });
	}

	return sseStream<ImportEvent>(async (send) => {
		const items: ImportResultItem[] = [];
		const alreadyImported = loadImportedUrls(importLogPath(v));
		// #36: cross-run dedup (alreadyImported, from the persisted log) says
		// nothing about the SAME url appearing twice in THIS submission (a
		// pasted list with an accidental repeat, an OCW page linked from two
		// different listings) — without this, both copies would fetch,
		// convert and stage independently.
		const seenInBatch = new Set<string>();

		for (const rawLink of links) {
			send({ type: 'progress', stage: 'fetching', fileName: rawLink });

			let url: URL;
			try {
				url = rewriteArxivAbsToPdf(validateLinkUrl(rawLink));
			} catch (err) {
				const item = failedItem(rawLink, err);
				items.push(item);
				send({ type: 'item', item });
				continue;
			}

			if (alreadyImported.has(url.href) || seenInBatch.has(url.href)) {
				const item: ImportResultItem = { id: crypto.randomUUID(), fileName: rawLink, status: 'skipped' };
				items.push(item);
				send({ type: 'item', item });
				continue;
			}
			seenInBatch.add(url.href);

			const importId = crypto.randomUUID();
			try {
				// The whole fetch/convert/stage pipeline (YouTube branch, SSRF guard, robots, size cap) lives in
				// stage-url.ts so the MCP import route runs the very same code.
				const { title, warnings } = await stageUrl(v, url, importId);
				const item: ImportResultItem = {
					id: crypto.randomUUID(),
					fileName: rawLink,
					status: 'pending',
					importId,
					proposed: { title, domain, level: 'undergraduate' },
					warnings
				};
				items.push(item);
				send({ type: 'item', item });
			} catch (err) {
				const item = failedItem(rawLink, err);
				items.push(item);
				send({ type: 'item', item });
			}
		}

		const summary: ImportSummary = { items };
		send({ type: 'done', summary });
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `links import stream: ${message}` }));
};
