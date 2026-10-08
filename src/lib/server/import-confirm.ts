import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { stagingDir, resolveLibraryPath, slugify, appendImportLog } from './library';
import { indexLibraryFile } from './incrementalIndex';
import { AppError } from './app-error';
import { sanitizeDomain } from './domain-name';
import { readMeta, deleteMeta, IMPORT_ID_RE } from './pending-imports';
import { relinkAttachmentsForMove, libraryRelPath } from './converted-images';
import type { VaultContext } from './vaults';

/**
 * The one copy of "move a staged note into the library and index it", shared by
 * the user's confirm click (POST /api/library/import/[id]/confirm) and the
 * app's own auto-confirm of MCP imports (mcp-auto-confirm.ts). Sharing it is the
 * point: an auto-confirmed note must be byte-for-byte what a manual confirm of
 * the same proposal would have produced (frontmatter, slug, attachment links,
 * index entry, import log), with the same rollback when indexing fails.
 *
 * Throws AppError (never an HTTP error) so non-route callers can use it; the
 * route re-raises it as a coded HTTP error.
 */

/** Imports being confirmed right now in this process: the user's click and the auto-confirm can race. */
const confirming = new Set<string>();

export interface ConfirmInput {
	title: string;
	domain: string;
	level?: string;
	/** True when the app confirmed on the user's standing setting instead of a click; recorded in the import log. */
	autoConfirmed?: boolean;
}

/** Swappable so tests can run the file/log/rollback effects without an embedding backend. */
export type ConfirmIndexer = (v: VaultContext, absPath: string, relPath: string) => Promise<void>;

export async function confirmStagedImport(
	v: VaultContext,
	importId: string,
	input: ConfirmInput,
	deps: { indexer?: ConfirmIndexer } = {}
): Promise<{ path: string }> {
	// importId goes straight into path.join(stagingDir(v), ...) below; every real id is a
	// crypto.randomUUID(), so requiring that shape rejects a traversal id.
	if (!IMPORT_ID_RE.test(importId)) throw new AppError('VALIDATION_INVALID', { field: 'importId' });

	const stagedPath = path.join(stagingDir(v), `${importId}.md`);
	if (!fs.existsSync(stagedPath)) throw new AppError('IMPORT_EXPIRED', undefined, 404);
	if (confirming.has(importId)) throw new AppError('IMPORT_EXPIRED', undefined, 404);

	// Imports staged by an MCP client are marked in the import log, so the library's history shows who brought them in.
	const byMcp = readMeta(v, importId)?.by === 'mcp';

	if (!input.title?.trim()) throw new AppError('VALIDATION_REQUIRED', { field: 'title' });
	if (!input.domain?.trim()) throw new AppError('VALIDATION_REQUIRED', { field: 'domain' });

	confirming.add(importId);
	try {
		// Same normalization as the batch import: NFC, no Windows-invalid or
		// control characters, no indexer-excluded / reserved folder names.
		const domain = sanitizeDomain(input.domain);

		const raw = fs.readFileSync(stagedPath, 'utf-8');
		const parsed = matter(raw);
		const frontmatter: Record<string, unknown> = {
			...parsed.data,
			title: input.title.trim(),
			domain,
			level: input.level || 'undergraduate'
		};

		const filename = `${slugify(v, input.title, domain)}.md`;
		const relPath = `${domain}/${filename}`;
		const destAbs = resolveLibraryPath(v, relPath);
		fs.mkdirSync(path.dirname(destAbs), { recursive: true });
		// Image links in a staged note are relative to _meta/staging/; re-point them for the final folder.
		const content = relinkAttachmentsForMove(parsed.content, libraryRelPath(v, stagedPath), relPath);
		const finalRaw = matter.stringify(content, frontmatter);
		fs.writeFileSync(destAbs, finalRaw, 'utf-8');

		const logEntry = (status: string) => ({
			sourcePath: relPath,
			sourceUrl: frontmatter.source_url,
			sha256: crypto.createHash('sha256').update(finalRaw).digest('hex'),
			sourceSha256: frontmatter.source_sha256,
			importedAt: new Date().toISOString(),
			status,
			tool: frontmatter.converted_by ?? 'upload',
			...(byMcp ? { by: 'mcp' } : {}),
			...(input.autoConfirmed ? { autoConfirmed: true } : {})
		});

		// #11: indexLibraryFile can fail (a corrupt DB handle, an Ollama call that
		// errors mid-embedding) after the file already landed in the library tree
		// — until now that left an unindexed orphan behind with no signal at all:
		// not in the index, not back in staging, no log entry either way, and
		// nothing in the UI to say it needed a retry.
		try {
			await (deps.indexer ?? indexLibraryFile)(v, destAbs, relPath);
		} catch (err) {
			fs.rmSync(destAbs, { force: true });
			// The staged note goes back with its original links, so its converted images stay referenced by it:
			// nothing to delete here (deleting them would break the restored note). Only a later cancel may.
			fs.writeFileSync(stagedPath, raw, 'utf-8');
			appendImportLog(v, logEntry('indekslenmedi'));
			// An unreachable embedding model is the common case (Ollama not running): show a localized reason
			// instead of the raw "EMBEDDING_UNAVAILABLE {...}" text, which is English and code-shaped.
			if (err instanceof AppError && err.code === 'EMBEDDING_UNAVAILABLE') {
				throw new AppError('IMPORT_INDEX_FAILED', { reason: 'embedding_unreachable' }, 503);
			}
			throw new AppError('IMPORT_INDEX_FAILED', { detail: err instanceof Error ? err.message : 'bilinmeyen hata' }, 500);
		}

		appendImportLog(v, logEntry('converted'));

		fs.rmSync(stagedPath, { force: true });
		deleteMeta(v, importId);

		return { path: relPath };
	} finally {
		confirming.delete(importId);
	}
}
