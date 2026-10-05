import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import type { RequestHandler } from './$types';
import { enqueueConversion } from '$lib/server/convertQueue';
import { relDirToSegments } from '$lib/server/batch-paths';
import { sanitizeDomain } from '$lib/server/domain-name';
import { scanRegistry } from '$lib/server/scan-registry';
import { resolveScannedFile } from '$lib/server/folder-scan';
import {
	stagingDir,
	resolveLibraryPath,
	slugify,
	appendImportLog,
	importLogPath,
	loadImportedSourceHashes,
	safeBasename,
	ALLOWED_EXTENSIONS,
	CODE_EXTENSIONS,
	MAX_UPLOAD_BYTES
} from '$lib/server/library';
import { indexLibraryFile } from '$lib/server/incrementalIndex';
import { inflightImportHashes } from '$lib/server/inflight-hashes';
import { vaultFromId } from '$lib/server/requestVault';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import { AppError, toCodedError, errorPayload } from '$lib/server/app-error';
import type { ImportEvent, ImportResultItem, ImportSummary } from '$lib/types';

/**
 * Batch upload — no per-file confirm step (would be tedious for N files):
 * defaults are auto-applied (title = converter's H1/filename guess, domain =
 * the folder the user dropped into, level = form-supplied, default
 * undergraduate), needs_review carried through from the converter, and the
 * whole thing ends in a pdf2md-style summary. Single-file upload
 * (/api/import) keeps the nicer confirm-dialog flow — see the Faz 5 plan for
 * why the two differ.
 *
 * BatchImport.svelte (multi-file/folder import) now sends ONE file per
 * request — a sequential client-side loop, not a single multi-file POST —
 * so the Ollama-eviction win below (exclusiveGpu) applies file-by-file
 * rather than for a whole batch stuck behind one slow document; `files`
 * still accepts several entries for backward compat with any other caller.
 * `concurrency` (1..4, clamped HERE, never trusted from the client) lets the
 * dialog's "parallel processing" option run several of these requests at
 * once: it is passed to enqueueConversion, whose shared-slot limit is what
 * actually bounds simultaneous conversions.
 * Two ways to name a file: an uploaded `files` entry (browsers, macOS and
 * Windows desktop), or `scanId` + `relPath` for a file inside a folder the
 * server scanned earlier (POST /api/import/batch/scan, the Linux desktop
 * app). The scanned file is resolved only inside the scanned root, then goes
 * through exactly the same dedupe / conversion / indexing path.
 * `relDir` carries the picked folder's subdirectory structure (already
 * stripped of the folder's own top-level name by the client — that becomes
 * `domain`); `level` is the study level chosen in the dialog.
 */
export const POST: RequestHandler = async ({ request }) => {
	const formData = await request.formData();
	// NFC, no Windows-invalid/control chars, indexer-excluded and reserved names suffixed, length-capped.
	const domain = sanitizeDomain((formData.get('domain') as string | null) ?? '');
	const relDir = (formData.get('relDir') as string | null) ?? '';
	const levelRaw = (formData.get('level') as string | null) ?? '';
	const level = levelRaw === 'graduate' || levelRaw === 'phd' ? levelRaw : 'undergraduate';
	const concurrencyParsed = Number.parseInt(String(formData.get('concurrency') ?? ''), 10);
	const concurrency = Number.isFinite(concurrencyParsed) ? Math.min(4, Math.max(1, concurrencyParsed)) : 1;
	const files = formData.getAll('files').filter((f): f is File => f instanceof File);
	const v = vaultFromId(formData.get('vault') as string | null);
	const scanId = formData.get('scanId');
	const scanRelPath = formData.get('relPath');

	// sseStream, not a bare ReadableStream — same crash this fixed for the
	// five /api/generate/* routes and for /api/import: an abandoned batch
	// upload (a real risk when it's converting several files back to back)
	// used to throw an unhandled error out of the next send() and take the
	// whole server down instead of just this one request.
	return sseStream<ImportEvent>(async (send) => {
		const items: ImportResultItem[] = [];

		interface BatchInput {
			name: string;
			size: number;
			relDir: string;
			bytes: () => Promise<Buffer>;
		}
		const inputs: BatchInput[] = files.map((f) => ({
			name: f.name,
			size: f.size,
			relDir,
			bytes: async () => Buffer.from(await f.arrayBuffer())
		}));
		if (typeof scanId === 'string' && scanId) {
			try {
				const rec = scanRegistry.get(scanId, v.id);
				if (!rec) throw new AppError('SCAN_EXPIRED', undefined, 404);
				// Only paths the scan itself listed as importable.
				if (typeof scanRelPath !== 'string' || !rec.allowed.has(scanRelPath)) throw new AppError('SCAN_PATH_INVALID');
				const resolved = resolveScannedFile(rec.root, scanRelPath);
				const parts = scanRelPath.split('/');
				const name = parts.pop() as string;
				inputs.push({
					name,
					size: resolved.size,
					relDir: parts.join('/'),
					bytes: async () => fs.readFileSync(resolved.abs)
				});
			} catch (err) {
				send({ type: 'error', ...errorPayload(err) });
				return;
			}
		}
		// E5: content-addressed, not just "have we seen this exact URL/name
		// before" — catches the same PDF re-dropped under a different
		// filename, which a name-only check never would. The log is re-read
		// per file (below), right before the in-flight reservation, so a
		// parallel request that finished a moment ago is already in it.

		for (const input of inputs) {
			// NFC: macOS can hand NFD names; keep one canonical spelling.
			const safeName = safeBasename(input.name).normalize('NFC');
			const dir = [domain, ...relDirToSegments(input.relDir)].join('/');
			send({ type: 'progress', stage: 'converting', fileName: safeName });

			const ext = path.extname(safeName).toLowerCase() || '.bin';
			if (!ALLOWED_EXTENSIONS.has(ext) && !CODE_EXTENSIONS.has(ext)) {
				const item: ImportResultItem = {
					id: crypto.randomUUID(),
					fileName: safeName,
					status: 'failed',
					code: 'UNSUPPORTED_FILE_TYPE',
					params: { ext: ext || '?' },
					reason: 'UNSUPPORTED_FILE_TYPE'
				};
				items.push(item);
				send({ type: 'item', item });
				continue;
			}
			if (input.size > MAX_UPLOAD_BYTES) {
				const item: ImportResultItem = {
					id: crypto.randomUUID(),
					fileName: safeName,
					status: 'failed',
					code: 'FILE_TOO_LARGE',
					params: { limitMb: Math.round(MAX_UPLOAD_BYTES / (1024 * 1024)) },
					reason: 'FILE_TOO_LARGE'
				};
				items.push(item);
				send({ type: 'item', item });
				continue;
			}

			const fileBytes = await input.bytes();
			// A scanned file can have grown since the scan; re-check what was actually read.
			if (fileBytes.length > MAX_UPLOAD_BYTES) {
				const item: ImportResultItem = {
					id: crypto.randomUUID(),
					fileName: safeName,
					status: 'failed',
					code: 'FILE_TOO_LARGE',
					params: { limitMb: Math.round(MAX_UPLOAD_BYTES / (1024 * 1024)) },
					reason: 'FILE_TOO_LARGE'
				};
				items.push(item);
				send({ type: 'item', item });
				continue;
			}
			const sourceSha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');
			// No await between this read, the check and reserve(): another
			// request cannot slip in. The in-flight set covers the window
			// where an identical file is still converting (not yet logged).
			const alreadyImported = loadImportedSourceHashes(importLogPath(v));
			if (alreadyImported.has(sourceSha256) || !inflightImportHashes.reserve(v.id, sourceSha256)) {
				const item: ImportResultItem = { id: crypto.randomUUID(), fileName: safeName, status: 'skipped' };
				items.push(item);
				send({ type: 'item', item });
				continue;
			}

			let workDir = '';
			try {
				workDir = path.join(stagingDir(v), crypto.randomUUID());
				fs.mkdirSync(workDir, { recursive: true });
				const tempIn = path.join(workDir, `original${ext}`);
				fs.writeFileSync(tempIn, fileBytes);

				const result = await enqueueConversion(tempIn, workDir, 'auto', undefined, safeName, undefined, {
					exclusiveGpu: true,
					concurrency
				});
				if (!result.outPath) throw new AppError('CONVERSION_EMPTY');

				const raw = fs.readFileSync(result.outPath, 'utf-8');
				const parsed = matter(raw);
				const title = (parsed.data.title as string) ?? path.parse(safeName).name;
				const needsReview = parsed.data.needs_review === true;
				const frontmatter: Record<string, unknown> = {
					...parsed.data,
					title,
					domain,
					level
				};

				const filename = `${slugify(v, title, dir)}.md`;
				const relPath = `${dir}/${filename}`;
				const destAbs = resolveLibraryPath(v, relPath);
				fs.mkdirSync(path.dirname(destAbs), { recursive: true });
				const finalRaw = matter.stringify(parsed.content, frontmatter);
				fs.writeFileSync(destAbs, finalRaw, 'utf-8');
				await indexLibraryFile(v, destAbs, relPath);

				appendImportLog(v, {
					sourcePath: relPath,
					sha256: crypto.createHash('sha256').update(finalRaw).digest('hex'),
					sourceSha256: frontmatter.source_sha256 ?? sourceSha256,
					importedAt: new Date().toISOString(),
					status: needsReview ? 'needs_review' : 'converted',
					tool: frontmatter.converted_by ?? 'upload-batch'
				});

				const item: ImportResultItem = {
					id: crypto.randomUUID(),
					fileName: safeName,
					status: needsReview ? 'needs_review' : 'converted',
					path: relPath
				};
				items.push(item);
				send({ type: 'item', item });
			} catch (err) {
				const coded = toCodedError(err);
				const item: ImportResultItem = {
					id: crypto.randomUUID(),
					fileName: safeName,
					status: 'failed',
					code: coded.code,
					params: coded.params,
					reason: coded.code
				};
				items.push(item);
				send({ type: 'item', item });
			} finally {
				if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
				inflightImportHashes.release(v.id, sourceSha256);
			}
		}

		const summary: ImportSummary = { items };
		send({ type: 'done', summary });
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `batch import stream: ${message}` }));
};
