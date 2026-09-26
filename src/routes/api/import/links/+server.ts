import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import type { RequestHandler } from './$types';
import { enqueueConversion } from '$lib/server/convertQueue';
import { enqueueWebExtract } from '$lib/server/webExtractQueue';
import { enqueueYoutubeTranscript } from '$lib/server/youtubeQueue';
import {
	isPdfBytes,
	validateLinkUrl,
	assertPublicHost,
	loadImportedUrls,
	sourceNameFromUrl,
	isYoutubeUrl,
	fetchWithRetry,
	pdfContentTypeMismatch,
	rewriteArxivAbsToPdf,
	fetchRobotsTxt,
	isAllowedByRobots,
	politeDelay
} from '$lib/server/link-import';
import { stagingDir, importLogPath } from '$lib/server/library';
import { vaultFromId } from '$lib/server/requestVault';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import { AppError, fail, toCodedError } from '$lib/server/app-error';
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

			// #17: a YouTube link pasted into the generic importer must go
			// through the transcript sidecar, not be fetched as an ordinary
			// web page (trafilatura would extract youtube.com's JS-shell
			// boilerplate, never the actual video content).
			if (isYoutubeUrl(url)) {
				const importId = crypto.randomUUID();
				const workDir = path.join(stagingDir(v), importId);
				fs.mkdirSync(workDir, { recursive: true });
				try {
					const result = await enqueueYoutubeTranscript(url.href, workDir);
					if (!result.outPath) throw new AppError('TRANSCRIPT_EMPTY');
					fs.copyFileSync(result.outPath, path.join(stagingDir(v), `${importId}.md`));
					const item: ImportResultItem = {
						id: crypto.randomUUID(),
						fileName: rawLink,
						status: 'pending',
						importId,
						proposed: { title: (result.frontmatter.title as string) ?? 'YouTube video', domain, level: 'undergraduate' },
						warnings: result.warnings ?? []
					};
					items.push(item);
					send({ type: 'item', item });
				} catch (err) {
					const item = failedItem(rawLink, err);
					items.push(item);
					send({ type: 'item', item });
				} finally {
					fs.rmSync(workDir, { recursive: true, force: true });
				}
				continue;
			}

			try {
				await assertPublicHost(url);
			} catch (err) {
				const item = failedItem(rawLink, err);
				items.push(item);
				send({ type: 'item', item });
				continue;
			}

			// Aşama 10 #3: robots.txt is cached per origin (fetchRobotsTxt),
			// so a batch of several links from the same site fetches it once,
			// not once per link.
			const robotsTxt = await fetchRobotsTxt(url.origin);
			if (!isAllowedByRobots(url, robotsTxt)) {
				const item = failedItem(rawLink, new AppError('LINK_ROBOTS_DISALLOWED', undefined, 403));
				items.push(item);
				send({ type: 'item', item });
				continue;
			}
			await politeDelay(url.hostname);

			const importId = crypto.randomUUID();
			const workDir = path.join(stagingDir(v), importId);
			fs.mkdirSync(workDir, { recursive: true });

			try {
				const bytes = await fetchWithRetry(url);
				if (bytes.length === 0) throw new AppError('LINK_EMPTY_RESPONSE');

				const isPdf = isPdfBytes(bytes);
				if (pdfContentTypeMismatch(url, isPdf)) {
					throw new AppError('LINK_PDF_NOT_PDF');
				}
				const tempIn = path.join(workDir, isPdf ? 'original.pdf' : 'original.html');
				fs.writeFileSync(tempIn, bytes);

				const result = isPdf
					? await enqueueConversion(tempIn, workDir, 'auto', undefined, sourceNameFromUrl(url))
					: await enqueueWebExtract(tempIn, url.href, workDir);
				if (!result.outPath) throw new AppError('CONVERSION_EMPTY');

				const raw = fs.readFileSync(result.outPath, 'utf-8');
				const parsed = matter(raw);
				const title = (parsed.data.title as string) ?? url.hostname;
				const frontmatter: Record<string, unknown> = { ...parsed.data, source_url: url.href };
				fs.writeFileSync(path.join(stagingDir(v), `${importId}.md`), matter.stringify(parsed.content, frontmatter), 'utf-8');

				const item: ImportResultItem = {
					id: crypto.randomUUID(),
					fileName: rawLink,
					status: 'pending',
					importId,
					proposed: { title, domain, level: 'undergraduate' },
					warnings: result.warnings ?? []
				};
				items.push(item);
				send({ type: 'item', item });
			} catch (err) {
				const item = failedItem(rawLink, err);
				items.push(item);
				send({ type: 'item', item });
			} finally {
				fs.rmSync(workDir, { recursive: true, force: true });
			}
		}

		const summary: ImportSummary = { items };
		send({ type: 'done', summary });
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `links import stream: ${message}` }));
};
