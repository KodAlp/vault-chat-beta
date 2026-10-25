import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readAvSettings, writeAvSettings } from '#lib/server/av-settings.js';
import { AppError, fail } from '#lib/server/app-error.js';

/** Antivirus scan of imported files: `{ avScan: boolean }`, on by default. Session-gated like /api/settings/mcp. */
export const GET: RequestHandler = async () => {
	return json(readAvSettings());
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		fail('VALIDATION_INVALID', { field: 'body' });
	}
	try {
		return json(writeAvSettings(body as { avScan?: unknown }));
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		throw err;
	}
};
