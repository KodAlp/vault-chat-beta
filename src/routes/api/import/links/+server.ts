import crypto from 'node:crypto';
import type { RequestHandler } from './$types';
import { validateLinkUrl, loadImportedUrls, rewriteArxivAbsToPdf } from '$lib/server/link-import';
import { runPool } from '$lib/server/concurrency';
import { linkManifestPath, appendManifestEntry } from '$lib/server/link-manifest';
import { stageUrl } from '$lib/server/stage-url';
import { importLogPath } from '$lib/server/library';
import { vaultFromId } from '$lib/server/requestVault';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import { fail, toCodedError } from '$lib/server/app-error';
import type { ImportEvent, ImportResultItem, ImportSummary } from '$lib/types';

const MAX_LINKS_PER_BATCH = 50;
// Downloads overlap; conversion stays serialized by sharedJobMutex.
const LINK_CONCURRENCY = 4;

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
 * Küçük ilk dilim: PDF linkleri mevcut convert.py'ye, web sayfaları
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
		// Cross-run dedup (alreadyImported, from the persisted log) says
		// nothing about the SAME url appearing twice in THIS submission (a
		// pasted list with an accidental repeat, an OCW page linked from two
		// different listings) — without this, both copies would fetch,
		// convert and stage independently.
		const seenInBatch = new Set<string>();
		const batchId = crypto.randomUUID();
		const manifest = linkManifestPath(v);

		// Emits a finished item and records it in the link manifest. A manifest
		// write failure must never fail the import itself.
		const emit = (item: ImportResultItem, url: string) => {
			items.push(item);
			send({ type: 'item', item });
			try {
				appendManifestEntry(manifest, {
					batchId,
					url,
					status: item.status === 'failed' ? 'failed' : item.status === 'pending' ? 'pending' : 'skipped',
					...(item.status === 'failed' && item.code ? { code: item.code } : {}),
					...(item.importId ? { importId: item.importId } : {}),
					at: new Date().toISOString()
				});
			} catch (err) {
				logAppEvent({ kind: 'fatal_error', message: `link manifest write: ${err instanceof Error ? err.message : String(err)}` });
			}
		};

		// Dedup runs synchronously, before anything is scheduled, so two identical
		// urls can never both start. Only links that survive become pool tasks.
		const tasks: { rawLink: string; url: URL }[] = [];
		for (const rawLink of links) {
			let url: URL;
			try {
				url = rewriteArxivAbsToPdf(validateLinkUrl(rawLink));
			} catch (err) {
				send({ type: 'progress', stage: 'fetching', fileName: rawLink });
				emit(failedItem(rawLink, err), rawLink);
				continue;
			}

			if (alreadyImported.has(url.href) || seenInBatch.has(url.href)) {
				emit({ id: crypto.randomUUID(), fileName: rawLink, status: 'skipped' }, url.href);
				continue;
			}
			seenInBatch.add(url.href);
			tasks.push({ rawLink, url });
		}

		// Conversion is already serialized by sharedJobMutex, so concurrency here
		// only overlaps the downloads of later links with the conversion of
		// earlier ones. Items are emitted in completion order.
		await runPool(tasks, LINK_CONCURRENCY, async ({ rawLink, url }) => {
			send({ type: 'progress', stage: 'fetching', fileName: rawLink });
			const importId = crypto.randomUUID();
			try {
				// The whole fetch/convert/stage pipeline (YouTube branch, SSRF guard, robots, size cap) lives in
				// stage-url.ts so the MCP import route runs the very same code.
				const { title, warnings } = await stageUrl(v, url, importId);
				emit(
					{
						id: crypto.randomUUID(),
						fileName: rawLink,
						status: 'pending',
						importId,
						proposed: { title, domain, level: 'undergraduate' },
						warnings
					},
					url.href
				);
			} catch (err) {
				emit(failedItem(rawLink, err), url.href);
			}
		});

		const summary: ImportSummary = { items };
		send({ type: 'done', summary });
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `links import stream: ${message}` }));
};
