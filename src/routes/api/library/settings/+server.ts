import type { RequestHandler } from './$types';
import { getLibrarySettings, saveLibrarySettings } from '#lib/server/library.js';
import { vaultFromUrl, vaultFromId } from '#lib/server/requestVault.js';
import { fail } from '#lib/server/app-error.js';

export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	return Response.json(getLibrarySettings(v));
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as {
		keepOriginals: boolean;
		allowedLanguages: string[];
		responseLanguage?: 'match' | 'fixed';
		hiddenFolders: string[];
		flattenFolders: string[];
		vault?: string;
	};
	if (body.responseLanguage !== undefined && body.responseLanguage !== 'match' && body.responseLanguage !== 'fixed') {
		fail('LIBRARY_SETTINGS_INVALID_RESPONSE_LANGUAGE', undefined, 400);
	}
	const v = vaultFromId(body.vault);
	saveLibrarySettings(v, {
		keepOriginals: body.keepOriginals,
		allowedLanguages: body.allowedLanguages,
		responseLanguage: body.responseLanguage ?? 'match',
		hiddenFolders: body.hiddenFolders,
		flattenFolders: body.flattenFolders
	});
	return Response.json({ ok: true });
};
