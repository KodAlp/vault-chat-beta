import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
// undici's own fetch, not the global one: its RequestInit is typed with
// `dispatcher` (a Node/undici extension the Fetch API's own lib.dom types
// don't know about), and it's the exact same implementation Node's global
// fetch delegates to — no behavior difference, just proper types for a
// feature we rely on for SSRF pinning (pinnedDispatcher).
import { fetch as undiciFetch } from 'undici';
import type { RequestHandler } from './$types';
import { enqueueConversion } from '$lib/server/convertQueue';
import { enqueueWebExtract } from '$lib/server/webExtractQueue';
import {
	isPdfBytes,
	validateLinkUrl,
	assertPublicHost,
	pinnedDispatcher,
	loadImportedUrls,
	sourceNameFromUrl
} from '$lib/server/link-import';
import { stagingDir, resolveLibraryPath, slugify, appendImportLog, importLogPath, MAX_UPLOAD_BYTES } from '$lib/server/library';
import { indexLibraryFile } from '$lib/server/incrementalIndex';
import { vaultFromId } from '$lib/server/requestVault';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import type { ImportEvent, ImportResultItem, ImportSummary } from '$lib/types';

const MAX_LINKS_PER_BATCH = 50;
const LINK_FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; vault-chat-import/1.0)';

/**
 * Küçük ilk dilim (Faz 15): PDF linkleri mevcut convert.py'ye, web sayfaları
 * yeni extract_web.py/trafilatura'ya gider. Sıralı (sharedJobMutex, batch
 * upload ile aynı desen). Güvenlik: assertPublicHost (SSRF), akış halinde
 * boyut sınırı (Content-Length'e güvenmeden), process timeout — bkz. plan.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { links?: unknown; domain?: unknown; vault?: unknown };
	const domain = typeof body.domain === 'string' && body.domain.trim() ? body.domain.trim() : 'genel';
	const links = Array.isArray(body.links) ? body.links.filter((l): l is string => typeof l === 'string' && l.trim() !== '') : [];
	const v = vaultFromId(typeof body.vault === 'string' ? body.vault : null);

	if (links.length === 0) {
		return new Response(JSON.stringify({ error: 'En az bir bağlantı gerekli' }), { status: 400 });
	}
	if (links.length > MAX_LINKS_PER_BATCH) {
		return new Response(JSON.stringify({ error: `En fazla ${MAX_LINKS_PER_BATCH} bağlantı desteklenir` }), { status: 400 });
	}

	return sseStream<ImportEvent>(async (send) => {
		const items: ImportResultItem[] = [];
		const alreadyImported = loadImportedUrls(importLogPath(v));

		for (const rawLink of links) {
			send({ type: 'progress', stage: 'fetching', fileName: rawLink });

			let url: URL;
			try {
				url = validateLinkUrl(rawLink);
				await assertPublicHost(url);
			} catch (err) {
				const item: ImportResultItem = { fileName: rawLink, status: 'failed', reason: err instanceof Error ? err.message : 'Geçersiz bağlantı' };
				items.push(item);
				send({ type: 'item', item });
				continue;
			}

			if (alreadyImported.has(url.href)) {
				const item: ImportResultItem = { fileName: rawLink, status: 'skipped' };
				items.push(item);
				send({ type: 'item', item });
				continue;
			}

			const workDir = path.join(stagingDir(v), crypto.randomUUID());
			fs.mkdirSync(workDir, { recursive: true });

			try {
				const bytes = await fetchWithCap(url);
				if (bytes.length === 0) throw new Error('Boş yanıt');

				const isPdf = isPdfBytes(bytes);
				const tempIn = path.join(workDir, isPdf ? 'original.pdf' : 'original.html');
				fs.writeFileSync(tempIn, bytes);

				const result = isPdf
					? await enqueueConversion(tempIn, workDir, 'auto', undefined, sourceNameFromUrl(url))
					: await enqueueWebExtract(tempIn, url.href, workDir);
				if (!result.outPath) throw new Error('Dönüştürme çıktı üretmedi');

				const raw = fs.readFileSync(result.outPath, 'utf-8');
				const parsed = matter(raw);
				const title = (parsed.data.title as string) ?? url.hostname;
				const needsReview = parsed.data.needs_review === true;
				const frontmatter: Record<string, unknown> = {
					...parsed.data,
					title,
					domain,
					level: 'undergraduate',
					source_url: url.href
				};

				const filename = `${slugify(v, title, domain)}.md`;
				const relPath = `${domain}/${filename}`;
				const destAbs = resolveLibraryPath(v, relPath);
				fs.mkdirSync(path.dirname(destAbs), { recursive: true });
				const finalRaw = matter.stringify(parsed.content, frontmatter);
				fs.writeFileSync(destAbs, finalRaw, 'utf-8');
				await indexLibraryFile(v, destAbs, relPath);

				appendImportLog(v, {
					sourcePath: relPath,
					sourceUrl: url.href,
					sha256: crypto.createHash('sha256').update(finalRaw).digest('hex'),
					// Only the PDF path has one — convert.py writes it, the HTML/
					// trafilatura path (extract_web.py) has no single "original
					// file" to hash in the same sense.
					sourceSha256: isPdf ? frontmatter.source_sha256 : undefined,
					importedAt: new Date().toISOString(),
					status: needsReview ? 'needs_review' : 'converted',
					tool: frontmatter.converted_by ?? 'import-links'
				});

				const item: ImportResultItem = {
					fileName: rawLink,
					status: needsReview ? 'needs_review' : 'converted',
					path: relPath
				};
				items.push(item);
				send({ type: 'item', item });
			} catch (err) {
				const item: ImportResultItem = { fileName: rawLink, status: 'failed', reason: err instanceof Error ? err.message : 'Bilinmeyen hata' };
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

const MAX_REDIRECTS = 5;

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
 */
async function fetchWithCap(url: URL): Promise<Buffer> {
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

		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get('location');
			if (!location) throw new Error(`Yönlendirme hedefsiz (${res.status})`);
			let next: URL;
			try {
				next = new URL(location, current);
			} catch {
				throw new Error(`Geçersiz yönlendirme hedefi: ${location}`);
			}
			if (next.protocol !== 'http:' && next.protocol !== 'https:') {
				throw new Error(`Desteklenmeyen yönlendirme protokolü: ${next.protocol}`);
			}
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
