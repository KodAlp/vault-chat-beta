import crypto from 'node:crypto';
import path from 'node:path';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dataDir } from '$lib/server/env';
import { fail } from '$lib/server/app-error';
import { sanitizeDomain } from '$lib/server/domain-name';
import { importLogPath } from '$lib/server/library';
import { validateLinkUrl, rewriteArxivAbsToPdf, loadImportedUrls } from '$lib/server/link-import';
import { stageUrl } from '$lib/server/stage-url';
import type { ConvertEvent } from '$lib/server/convertQueue';
import { readMcpSettings } from '$lib/server/mcp-settings';
import { validateImportPath } from '$lib/server/mcp-import-path';
import { failFrom, requireMcpVault, stageLocalFile, startDetachedImport } from '$lib/server/mcp-import';
import { activeImportCount, listPending, writeMeta, type PendingImportMeta } from '$lib/server/pending-imports';
import { getVaultMcpAutoConfirm } from '$lib/server/vaults';
import { listRecentlyConfirmed } from '$lib/server/mcp-auto-confirm';

/** Beyond this many conversions in flight an agent loop gets a 429 instead of an unbounded fetch/convert pile. */
const MAX_ACTIVE_IMPORTS = 25;
const MAX_TITLE_CHARS = 200;

/**
 * import_source: stages ONE source (a local file under a folder the user allowed in Settings, or a URL)
 * into the vault's staging area and answers immediately with an importId. The conversion runs detached
 * and reports through the staging sidecar (GET below / pending-imports.ts). Nothing reaches the library
 * or the index until the user confirms in the app (/api/library/import/[id]/confirm).
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (typeof body !== 'object' || body === null || Array.isArray(body)) fail('VALIDATION_INVALID', { field: 'body' });

	try {
		const hasPath = typeof body.path === 'string' && body.path.length > 0;
		const hasUrl = typeof body.url === 'string' && body.url.length > 0;
		if (hasPath === hasUrl) fail('VALIDATION_INVALID', { field: 'path|url' });

		const v = requireMcpVault(body.vault);
		const domain = sanitizeDomain(typeof body.domain === 'string' && body.domain.trim() ? body.domain : 'genel');
		const titleOverride =
			typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, MAX_TITLE_CHARS) : undefined;
		if (activeImportCount() >= MAX_ACTIVE_IMPORTS) fail('REQUEST_FAILED', { detail: 'too many imports in progress' }, 429);

		const importId = crypto.randomUUID();
		const now = new Date().toISOString();
		const baseMeta = {
			importId,
			status: 'queued' as const,
			warnings: [] as string[],
			by: 'mcp' as const,
			createdAt: now,
			updatedAt: now
		};
		let meta: PendingImportMeta;
		let job: (onEvent: (event: ConvertEvent) => void) => Promise<{ title: string; warnings: string[] }>;

		if (hasPath) {
			const file = validateImportPath(body.path, readMcpSettings().allowedImportRoots, [dataDir(), v.dir]);
			meta = {
				...baseMeta,
				source: { kind: 'path', name: file.name },
				proposed: { title: titleOverride ?? path.parse(file.name).name, domain, level: 'undergraduate' }
			};
			job = (onEvent) => stageLocalFile(v, importId, file, onEvent);
		} else {
			const url = rewriteArxivAbsToPdf(validateLinkUrl(body.url as string));
			// Same duplicate rule as the browser importer, but as a warning: the user decides at confirm time.
			const warnings = loadImportedUrls(importLogPath(v)).has(url.href) ? ['IMPORT_DUPLICATE_URL'] : [];
			meta = {
				...baseMeta,
				warnings,
				source: { kind: 'url', name: url.hostname },
				proposed: { title: titleOverride ?? url.hostname, domain, level: 'undergraduate' }
			};
			job = (onEvent) => stageUrl(v, url, importId, onEvent);
		}

		writeMeta(v, meta);
		startDetachedImport(v, meta, async (onEvent) => {
			const result = await job(onEvent);
			return titleOverride ? { ...result, title: titleOverride } : result;
		});
		// Read-only: the agent is told what the user's setting will do with the import, it cannot change it.
		return json({ vault: v.id, importId, status: 'queued', autoConfirm: getVaultMcpAutoConfirm(v.id) });
	} catch (err) {
		failFrom(err);
	}
};

/** list_pending_imports: the vault's staging area, newest first (queued / converting / ready / error), plus the
 * imports the app auto-confirmed in the last day (status 'confirmed', with the library path) so a polling agent
 * sees them enter the library instead of just vanishing from the pending list. */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const v = requireMcpVault(url.searchParams.get('vault'));
		return json({
			vault: v.id,
			autoConfirm: getVaultMcpAutoConfirm(v.id),
			imports: listPending(v),
			confirmed: listRecentlyConfirmed(v).map((c) => ({ ...c, status: 'confirmed' as const }))
		});
	} catch (err) {
		failFrom(err);
	}
};
