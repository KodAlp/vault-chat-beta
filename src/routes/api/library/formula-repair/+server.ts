import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { RequestHandler } from './$types';
import { readLibraryFile } from '#lib/server/library.js';
import { originalPathForSourceSha } from '#lib/server/originals.js';
import { attachmentsDir, META_DIR, ATTACHMENTS_SUBDIR } from '#lib/server/attachments.js';
import { findUnreadableFormulas } from '#lib/formula-repair.js';
import { runFormulaRepair } from '#lib/server/formula-repair-run.js';
import { vaultFromId } from '#lib/server/requestVault.js';
import type { VaultContext } from '#lib/server/vaults.js';
import { logAppEvent } from '#lib/server/app-log.js';
import { AppError, fail } from '#lib/server/app-error.js';

/** The note's text, or a 404 that does not tell "outside the library" from "missing" (same as /api/library/file). */
function readNote(v: VaultContext, notePath: string): string {
	try {
		return readLibraryFile(v, notePath);
	} catch {
		fail('NOT_FOUND', { entity: 'file' }, 404);
	}
}

/** The kept original for a note's raw text, or null (no source_sha256 / nothing kept for it). */
function findOriginal(v: VaultContext, raw: string): string | null {
	let sha: unknown;
	try {
		sha = matter(raw).data.source_sha256;
	} catch {
		return null;
	}
	return typeof sha === 'string' && sha ? originalPathForSourceSha(v, sha) : null;
}

/** Formulas being re-read right now (vault + note + image hash): a double click must not start a second run. */
const running = new Set<string>();

/**
 * Re-reads ONE unreadable formula of a note from the kept original PDF and returns LaTeX candidates.
 * Body `{ path, sha, vault? }`; response `{ page, bbox_source, candidates: [{latex, source, katexOk}], cropUrl? }`.
 * Never writes the note: the editor applies the chosen candidate to its draft and saving goes through the
 * normal PUT /api/library/file (revision + reindex), exactly like re-import.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { path?: unknown; sha?: unknown; vault?: unknown };
	if (typeof body.path !== 'string' || !body.path) fail('VALIDATION_REQUIRED', { field: 'path' });
	if (typeof body.sha !== 'string' || !/^[0-9a-f]{16}$/.test(body.sha)) fail('VALIDATION_REQUIRED', { field: 'sha' });
	const v = vaultFromId(typeof body.vault === 'string' ? body.vault : undefined);
	const notePath = body.path;
	const sha = body.sha;

	const raw = readNote(v, notePath);
	const block = findUnreadableFormulas(raw).find((b) => b.sha === sha);
	if (!block) fail('FORMULA_REPAIR_BLOCK_NOT_FOUND', undefined, 404);

	const original = findOriginal(v, raw);
	if (!original) fail('FORMULA_REPAIR_NO_ORIGINAL', undefined, 404);
	if (path.extname(original).toLowerCase() !== '.pdf') fail('FORMULA_REPAIR_NOT_PDF');

	// The crop the importer stored; <sha>.png under the vault's attachments folder (name validated above).
	const cropRel = `${META_DIR}/${ATTACHMENTS_SUBDIR}/${sha}.png`;
	const cropAbs = path.join(attachmentsDir(v), `${sha}.png`);
	const hasCrop = fs.existsSync(cropAbs);

	const lockKey = `${v.id}\0${notePath}\0${sha}`;
	if (running.has(lockKey)) fail('FORMULA_REPAIR_BUSY', undefined, 409);
	running.add(lockKey);
	try {
		const result = await runFormulaRepair({
			pdf: original,
			page: block.page,
			bbox: block.bbox,
			crop: hasCrop ? cropAbs : null,
			previousB64: block.previousB64
		});
		return Response.json({
			page: result.page || block.page,
			bbox_source: result.bboxSource,
			candidates: result.candidates,
			cropUrl: hasCrop ? `/api/library/attachment?${new URLSearchParams({ path: cropRel, vault: v.id }).toString()}` : undefined
		});
	} catch (err) {
		if (err instanceof AppError) {
			logAppEvent({ kind: 'generation_warning', message: `formula-repair: ${err.code} ${JSON.stringify(err.params ?? {})}` });
			throw fail(err.code, err.params, err.code === 'PROCESS_TIMEOUT' ? 504 : 422);
		}
		throw err;
	} finally {
		running.delete(lockKey);
	}
};
