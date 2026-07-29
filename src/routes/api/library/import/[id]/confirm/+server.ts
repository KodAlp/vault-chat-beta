import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stagingDir, resolveLibraryPath, slugify, appendImportLog } from '$lib/server/library';
import { indexLibraryFile } from '$lib/server/incrementalIndex';

export const POST: RequestHandler = async ({ params, request }) => {
	const stagedPath = path.join(stagingDir(), `${params.id}.md`);
	if (!fs.existsSync(stagedPath)) error(404, 'Bekleyen içe aktarma bulunamadı (süresi dolmuş olabilir)');

	const body = (await request.json()) as { title: string; domain: string; level: string };
	if (!body.title?.trim() || !body.domain?.trim()) error(400, 'title ve domain gerekli');

	const raw = fs.readFileSync(stagedPath, 'utf-8');
	const parsed = matter(raw);
	const frontmatter: Record<string, unknown> = {
		...parsed.data,
		title: body.title.trim(),
		domain: body.domain.trim(),
		level: body.level || 'undergraduate'
	};

	const filename = `${slugify(body.title, body.domain)}.md`;
	const relPath = `${body.domain}/${filename}`;
	const destAbs = resolveLibraryPath(relPath);
	fs.mkdirSync(path.dirname(destAbs), { recursive: true });
	const finalRaw = matter.stringify(parsed.content, frontmatter);
	fs.writeFileSync(destAbs, finalRaw, 'utf-8');

	await indexLibraryFile(destAbs, relPath);

	appendImportLog({
		sourcePath: relPath,
		sha256: crypto.createHash('sha256').update(finalRaw).digest('hex'),
		importedAt: new Date().toISOString(),
		status: 'converted',
		tool: frontmatter.converted_by ?? 'upload'
	});

	fs.rmSync(stagedPath, { force: true });

	return json({ ok: true, path: relPath });
};
