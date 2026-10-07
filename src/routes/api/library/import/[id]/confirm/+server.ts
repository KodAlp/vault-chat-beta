import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stagingDir, resolveLibraryPath, slugify, appendImportLog } from '$lib/server/library';
import { indexLibraryFile } from '$lib/server/incrementalIndex';
import { vaultFromId } from '$lib/server/requestVault';
import { AppError, fail } from '$lib/server/app-error';
import { sanitizeDomain } from '$lib/server/domain-name';
import { readMeta, deleteMeta } from '$lib/server/pending-imports';

/** params.id is never checked against resolveLibraryPath-style containment
 * before this — it goes straight into path.join(stagingDir(v), \`${id}.md\`)
 * below. Every real id is a crypto.randomUUID() minted by
 * POST /api/import (see that route), so requiring the UUID shape rejects a
 * traversal id (e.g. "../../../../Users/alp/belgeler/gizli") before it ever
 * reaches the filesystem, without narrowing what a legitimate request can do. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST: RequestHandler = async ({ params, request }) => {
	if (!UUID_RE.test(params.id)) fail('VALIDATION_INVALID', { field: 'importId' });

	const body = (await request.json()) as { title: string; domain: string; level: string; vault?: string };
	const v = vaultFromId(body.vault);

	const stagedPath = path.join(stagingDir(v), `${params.id}.md`);
	if (!fs.existsSync(stagedPath)) fail('IMPORT_EXPIRED', undefined, 404);

	// Imports staged by an MCP client are marked in the import log, so the library's history shows who brought them in.
	const byMcp = readMeta(v, params.id)?.by === 'mcp';

	if (!body.title?.trim()) fail('VALIDATION_REQUIRED', { field: 'title' });
	if (!body.domain?.trim()) fail('VALIDATION_REQUIRED', { field: 'domain' });

	// Same normalization as the batch import: NFC, no Windows-invalid or
	// control characters, no indexer-excluded / reserved folder names.
	const domain = sanitizeDomain(body.domain);

	const raw = fs.readFileSync(stagedPath, 'utf-8');
	const parsed = matter(raw);
	const frontmatter: Record<string, unknown> = {
		...parsed.data,
		title: body.title.trim(),
		domain,
		level: body.level || 'undergraduate'
	};

	const filename = `${slugify(v, body.title, domain)}.md`;
	const relPath = `${domain}/${filename}`;
	const destAbs = resolveLibraryPath(v, relPath);
	fs.mkdirSync(path.dirname(destAbs), { recursive: true });
	const finalRaw = matter.stringify(parsed.content, frontmatter);
	fs.writeFileSync(destAbs, finalRaw, 'utf-8');

	// #11: indexLibraryFile can fail (a corrupt DB handle, an Ollama call that
	// errors mid-embedding) after the file already landed in the library tree
	// — until now that left an unindexed orphan behind with no signal at all:
	// not in the index, not back in staging, no log entry either way, and
	// nothing in the UI to say it needed a retry.
	try {
		await indexLibraryFile(v, destAbs, relPath);
	} catch (err) {
		fs.rmSync(destAbs, { force: true });
		fs.writeFileSync(stagedPath, raw, 'utf-8');
		appendImportLog(v, {
			sourcePath: relPath,
			sourceUrl: frontmatter.source_url,
			sha256: crypto.createHash('sha256').update(finalRaw).digest('hex'),
			sourceSha256: frontmatter.source_sha256,
			importedAt: new Date().toISOString(),
			status: 'indekslenmedi',
			tool: frontmatter.converted_by ?? 'upload',
			...(byMcp ? { by: 'mcp' } : {})
		});
		// An unreachable embedding model is the common case (Ollama not running): show a localized reason
		// instead of the raw "EMBEDDING_UNAVAILABLE {...}" text, which is English and code-shaped.
		if (err instanceof AppError && err.code === 'EMBEDDING_UNAVAILABLE') {
			fail('IMPORT_INDEX_FAILED', { reason: 'embedding_unreachable' }, 503);
		}
		fail('IMPORT_INDEX_FAILED', { detail: err instanceof Error ? err.message : 'bilinmeyen hata' }, 500);
	}

	appendImportLog(v, {
		sourcePath: relPath,
		sourceUrl: frontmatter.source_url,
		sha256: crypto.createHash('sha256').update(finalRaw).digest('hex'),
		sourceSha256: frontmatter.source_sha256,
		importedAt: new Date().toISOString(),
		status: 'converted',
		tool: frontmatter.converted_by ?? 'upload',
		...(byMcp ? { by: 'mcp' } : {})
	});

	fs.rmSync(stagedPath, { force: true });
	deleteMeta(v, params.id);

	return json({ ok: true, path: relPath });
};
