import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { enqueueConversion, type ConvertEvent } from './convertQueue';
import { enqueueWebExtract } from './webExtractQueue';
import { enqueueYoutubeTranscript } from './youtubeQueue';
import {
	isPdfBytes,
	assertPublicHost,
	sourceNameFromUrl,
	isYoutubeUrl,
	fetchWithRetry,
	pdfContentTypeMismatch,
	fetchRobotsTxt,
	isAllowedByRobots,
	politeDelay
} from './link-import';
import { stagingDir } from './library';
import { importConvertedImages, libraryRelPath } from './converted-images';
import { keepOriginalCopy } from './originals';
import { AppError } from './app-error';
import type { VaultContext } from './vaults';
import { ocrLangArg } from './ocr-lang';
import { getLibrarySettings } from './library-read';

/**
 * The one copy of the "URL -> staged Markdown" pipeline, shared by the
 * browser's link importer (/api/import/links) and the MCP import tool
 * (/api/mcp/imports) so the SSRF-relevant path cannot drift between them:
 * assertPublicHost (private networks, DNS), robots.txt, a polite per-host
 * delay, a streamed size cap with retry (fetchWithRetry), PDF-vs-HTML split by
 * magic bytes, and the YouTube transcript branch.
 *
 * `url` must already have passed validateLinkUrl (+ rewriteArxivAbsToPdf) —
 * the callers do that first because they also need the normalized href for
 * duplicate detection. Writes `<stagingDir>/<importId>.md` and returns what
 * the confirm dialog needs; throws AppError/any error on failure and always
 * removes its scratch work dir. The library tree and index are never touched.
 */
export async function stageUrl(
	v: VaultContext,
	url: URL,
	importId: string,
	onEvent?: (event: ConvertEvent) => void
): Promise<{ title: string; warnings: string[] }> {
	// A YouTube link must go through the transcript sidecar, not be
	// fetched as an ordinary web page (trafilatura would extract youtube.com's
	// JS-shell boilerplate, never the actual video content).
	if (isYoutubeUrl(url)) {
		const workDir = path.join(stagingDir(v), importId);
		fs.mkdirSync(workDir, { recursive: true });
		try {
			const result = await enqueueYoutubeTranscript(url.href, workDir);
			if (!result.outPath) throw new AppError('TRANSCRIPT_EMPTY');
			fs.copyFileSync(result.outPath, path.join(stagingDir(v), `${importId}.md`));
			return { title: (result.frontmatter.title as string) ?? 'YouTube video', warnings: result.warnings ?? [] };
		} finally {
			fs.rmSync(workDir, { recursive: true, force: true });
		}
	}

	await assertPublicHost(url);

	// robots.txt is cached per origin (fetchRobotsTxt), so a batch
	// of several links from the same site fetches it once, not once per link.
	const robotsTxt = await fetchRobotsTxt(url.origin);
	if (!isAllowedByRobots(url, robotsTxt)) {
		throw new AppError('LINK_ROBOTS_DISALLOWED', undefined, 403);
	}
	await politeDelay(url.hostname);

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
			? await enqueueConversion(tempIn, workDir, 'auto', onEvent, sourceNameFromUrl(url), undefined, {
					ocrLang: ocrLangArg(undefined, getLibrarySettings(v).allowedLanguages)
				})
			: await enqueueWebExtract(tempIn, url.href, workDir);
		if (!result.outPath) throw new AppError('CONVERSION_EMPTY');

		const raw = fs.readFileSync(result.outPath, 'utf-8');
		const parsed = matter(raw);
		const title = (parsed.data.title as string) ?? url.hostname;
		const frontmatter: Record<string, unknown> = { ...parsed.data, source_url: url.href };
		const stagedMdPath = path.join(stagingDir(v), `${importId}.md`);
		// Only the PDF branch produces images; a web extraction reports none and passes through unchanged.
		const content = importConvertedImages(v, { outPath: result.outPath, images: 'images' in result ? result.images : undefined }, libraryRelPath(v, stagedMdPath), parsed.content);
		fs.writeFileSync(stagedMdPath, matter.stringify(content, frontmatter), 'utf-8');

		// Keep the downloaded PDF like an uploaded one: links rot (course pages, preprints get withdrawn) and a
		// kept file is what a later re-import can use. An HTML page is NOT kept: the extraction is the product,
		// a page snapshot is volatile and unbounded, and source_url already lets a re-import fetch it again.
		// YouTube has no file at all.
		if (isPdf) await keepOriginalCopy(v, tempIn, sourceNameFromUrl(url).replace(/(.pdf)?$/i, '.pdf'));

		return { title, warnings: result.warnings ?? [] };
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
}
