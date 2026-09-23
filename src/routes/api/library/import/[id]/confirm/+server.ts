import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stagingDir, resolveLibraryPath, slugify, appendImportLog } from '$lib/server/library';
import { indexLibraryFile } from '$lib/server/incrementalIndex';
import { vaultFromId } from '$lib/server/requestVault';

/** params.id is never checked against resolveLibraryPath-style containment
 * before this — it goes straight into path.join(stagingDir(v), \`${id}.md\`)
 * below. Every real id is a crypto.randomUUID() minted by
 * POST /api/import (see that route), so requiring the UUID shape rejects a
 * traversal id (e.g. "../../../../Users/alp/belgeler/gizli") before it ever
 * reaches the filesystem, without narrowing what a legitimate request can do. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST: RequestHandler = async ({ params, request }) => {
	if (!UUID_RE.test(params.id)) error(400, 'Geçersiz içe aktarma kimliği');

	const body = (await request.json()) as { title: string; domain: string; level: string; vault?: string };
	const v = vaultFromId(body.vault);

	const stagedPath = path.join(stagingDir(v), `${params.id}.md`);
	if (!fs.existsSync(stagedPath)) error(404, 'Bekleyen içe aktarma bulunamadı (süresi dolmuş olabilir)');

	if (!body.title?.trim() || !body.domain?.trim()) error(400, 'title ve domain gerekli');

	const raw = fs.readFileSync(stagedPath, 'utf-8');
	const parsed = matter(raw);
	const frontmatter: Record<string, unknown> = {
		...parsed.data,
		title: body.title.trim(),
		domain: body.domain.trim(),
		level: body.level || 'undergraduate'
	};

	const filename = `${slugify(v, body.title, body.domain)}.md`;
	const relPath = `${body.domain}/${filename}`;
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
			tool: frontmatter.converted_by ?? 'upload'
		});
		error(500, `Dosya kaydedildi ama indekslenemedi, staging'e geri alındı: ${err instanceof Error ? err.message : 'bilinmeyen hata'}`);
	}

	appendImportLog(v, {
		sourcePath: relPath,
		sourceUrl: frontmatter.source_url,
		sha256: crypto.createHash('sha256').update(finalRaw).digest('hex'),
		sourceSha256: frontmatter.source_sha256,
		importedAt: new Date().toISOString(),
		status: 'converted',
		tool: frontmatter.converted_by ?? 'upload'
	});

	fs.rmSync(stagedPath, { force: true });

	return json({ ok: true, path: relPath });
};
