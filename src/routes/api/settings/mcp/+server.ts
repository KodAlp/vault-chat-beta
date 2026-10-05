import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readMcpSettings, writeMcpSettings } from '$lib/server/mcp-settings';
import { AppError, fail } from '$lib/server/app-error';

/**
 * What the USER allows MCP clients to do (today: which folders import_source may read local files from).
 * An ordinary session-gated route — deliberately NOT under /api/mcp/, so the MCP token can never widen
 * its own allowlist (see mcp-gate.ts). The settings page that calls this comes in a later change.
 */
export const GET: RequestHandler = async () => {
	return json(readMcpSettings());
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		fail('VALIDATION_INVALID', { field: 'body' });
	}
	try {
		return json(writeMcpSettings(body as { allowedImportRoots?: unknown }));
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		throw err;
	}
};
