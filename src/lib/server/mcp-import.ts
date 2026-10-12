import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { enqueueConversion } from './convertQueue';
import { stagingDir, importLogPath, loadImportedSourceHashes } from './library';
import { keepOriginalCopy } from './originals';
import { discardStagedNote } from './converted-image-cleanup';
import { AppError, errorPayload, fail } from './app-error';
import { logAppEvent } from './app-log';
import { isVaultMcpExposed, type VaultContext } from './vaults';
import { vaultFromId } from './requestVault';
import { importConvertedImages, libraryRelPath } from './converted-images';
import type { ValidatedImportPath } from './mcp-import-path';
import { markImportActive, markImportInactive, readMeta, throttledTouch, touchMeta, updateMeta, type PendingImportMeta } from './pending-imports';
import type { ConvertEvent } from './convertQueue';
import { autoConfirmIfEligible } from './mcp-auto-confirm';

/**
 * Orchestration for the MCP import routes (api/mcp/imports): the request
 * handler only validates and writes the queued sidecar, then hands the
 * conversion to startDetachedImport() and answers immediately; everything
 * below runs after the response, reporting through the sidecar
 * (pending-imports.ts) instead of a stream.
 */

/** Liveness tick while a conversion runs without emitting events. */
const HEARTBEAT_MS = 5_000;

/** Rethrows any error as a coded HTTP error (the route's `catch` shape used across this app). */
export function failFrom(err: unknown): never {
	if (err instanceof AppError) fail(err.code, err.params, err.status);
	// An HttpError from fail()/error() already carries its code and status — let it through.
	throw err;
}

/** Resolves the vault and requires that the user opened it to MCP (same rule as the read tools' withVault). */
export function requireMcpVault(id: unknown): VaultContext {
	const v = vaultFromId(typeof id === 'string' && id.trim() ? id.trim() : null);
	if (!isVaultMcpExposed(v.id)) throw new AppError('MCP_VAULT_NOT_EXPOSED', { vault: v.id }, 403);
	return v;
}

function sha256OfFile(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		fs.createReadStream(file)
			.on('data', (chunk) => hash.update(chunk))
			.on('error', reject)
			.on('end', () => resolve(hash.digest('hex')));
	});
}

/**
 * The local-file counterpart of stage-url.ts, mirroring POST /api/import:
 * copy into a scratch work dir, convert (queued behind the shared job
 * mutex like every other conversion), land `<stagingDir>/<importId>.md`,
 * honour keepOriginals, and flag a content-identical earlier import. The
 * file was already validated (mcp-import-path.ts) and is read from its
 * realpath.
 */
export async function stageLocalFile(
	v: VaultContext,
	importId: string,
	file: ValidatedImportPath,
	onEvent?: (event: ConvertEvent) => void
): Promise<{ title: string; warnings: string[] }> {
	const workDir = path.join(stagingDir(v), importId);
	fs.mkdirSync(workDir, { recursive: true });
	try {
		const tempIn = path.join(workDir, `original${file.ext}`);
		fs.copyFileSync(file.real, tempIn);

		// E5: content-addressed duplicate check — a warning, not a block (the user decides at confirm time).
		const alreadyImportedHash = loadImportedSourceHashes(importLogPath(v)).has(await sha256OfFile(tempIn));

		const result = await enqueueConversion(tempIn, workDir, 'auto', onEvent, file.name);
		if (!result.outPath) throw new AppError('CONVERSION_EMPTY');

		const stagedMdPath = path.join(stagingDir(v), `${importId}.md`);
		fs.writeFileSync(
			stagedMdPath,
			importConvertedImages(v, result, libraryRelPath(v, stagedMdPath), fs.readFileSync(result.outPath, 'utf-8')),
			'utf-8'
		);

		await keepOriginalCopy(v, tempIn, file.name);

		const warnings = [...(result.warnings ?? [])];
		if (alreadyImportedHash) warnings.push('IMPORT_DUPLICATE_CONTENT');
		const fmTitle = result.frontmatter.title;
		return { title: typeof fmTitle === 'string' && fmTitle.trim() ? fmTitle : path.parse(file.name).name, warnings };
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
}

/**
 * Runs `job` after the HTTP response has been sent: queued -> converting ->
 * ready | error, each step persisted to the sidecar. Never throws and is
 * never awaited by the caller — a failure becomes status 'error' with a
 * coded error the agent can read (and an app-log line carrying the code
 * only, never a path or URL).
 *
 * If the user cancelled while it was converting (sidecar gone), the note the
 * job just staged is removed again rather than reappearing as an orphan.
 */
export function startDetachedImport(
	v: VaultContext,
	meta: PendingImportMeta,
	job: (onEvent: (event: ConvertEvent) => void) => Promise<{ title: string; warnings: string[] }>
): void {
	const { importId } = meta;
	markImportActive(importId);
	void (async () => {
		// updatedAt is what the UI/agent reads as "still alive". The converter only emits a handful of
		// progress events per file (one per stage, none while docling runs for minutes), so every event
		// bumps it (throttled) AND a heartbeat covers the silent stretches. touchMeta never writes to a
		// record that already left queued/converting.
		const touch = throttledTouch(() => {
			try {
				touchMeta(v, importId);
			} catch {
				// A failed heartbeat write must not fail the import; the final status write reports real problems.
			}
		});
		const heartbeat = setInterval(touch, HEARTBEAT_MS);
		heartbeat.unref?.();
		try {
			if (!updateMeta(v, importId, { status: 'converting' })) return;
			const result = await job(touch);
			const stagedMd = path.join(stagingDir(v), `${importId}.md`);
			const done = updateMeta(v, importId, {
				status: 'ready',
				proposed: { ...meta.proposed, title: result.title },
				warnings: [...meta.warnings, ...result.warnings]
			});
			// Cancelled meanwhile: drop the note AND the converted images only it used.
			if (!done) await discardStagedNote(v, stagedMd);
			else {
				// The vault's standing auto-confirm setting (off by default) is applied by the APP here, not the
				// MCP client. Isolated in its own try: whatever happens, a finished conversion must stay 'ready'
				// (the outer catch would turn it into an error and delete the staged note).
				try {
					await autoConfirmIfEligible(v, importId);
				} catch {
					// autoConfirmIfEligible reports its own failures through the sidecar; nothing more to do.
				}
			}
		} catch (err) {
			const payload = errorPayload(err);
			logAppEvent({ kind: 'fatal_error', message: `mcp import failed: ${payload.code}` });
			try {
				fs.rmSync(path.join(stagingDir(v), `${importId}.md`), { force: true });
				if (readMeta(v, importId)) {
					updateMeta(v, importId, { status: 'error', error: { code: payload.code, ...(payload.params ? { params: payload.params } : {}) } });
				}
			} catch {
				// Nothing more to do — the sidecar stays at 'converting' and listPending() reports it as interrupted.
			}
		} finally {
			clearInterval(heartbeat);
			markImportInactive(importId);
		}
	})();
}
