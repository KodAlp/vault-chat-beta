import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { describeVaultDeletion, deleteVault, listVaults, renameVault, setVaultMcpExposed } from '$lib/server/vaults';
import { countChatsForVault, deleteChatsForVault } from '$lib/server/chats-db';
import { closeVaultIndexDb } from '$lib/server/retrieve';
import { closeVaultStudyDb } from '$lib/server/study-db';
import { AppError, fail, toCodedError } from '$lib/server/app-error';
import type { ErrorCode } from '$lib/errors';

/** Preview for the delete-confirm dialog — how many chats would be lost.
 * Never deletes anything by itself. */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const info = describeVaultDeletion(params.id, countChatsForVault);
		return json(info);
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 404);
	}
};

export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as { name?: string; mcpExposed?: boolean };
	if (body.name === undefined && body.mcpExposed === undefined) {
		fail('VALIDATION_REQUIRED_ANY', { fields: "'name', 'mcpExposed'" });
	}
	if (body.name !== undefined && !body.name.trim()) fail('VAULT_NAME_EMPTY');

	try {
		let vault = listVaults().find((v) => v.id === params.id);
		if (!vault) throw new AppError('NOT_FOUND', { entity: 'vault', detail: params.id }, 404);
		if (body.name !== undefined) vault = renameVault(params.id, body.name);
		// İ6: a separate field, not folded into the name-rename above — a
		// caller flipping exposure alone must not also need to resend name.
		if (body.mcpExposed !== undefined) vault = setVaultMcpExposed(params.id, body.mcpExposed);
		return json({ vault });
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 404);
	}
};

/** Requires an explicit confirm — a bare DELETE call from a stray retry or
 * script must not destroy data. The client is expected to have already
 * shown the GET preview above before sending this. */
export const DELETE: RequestHandler = async ({ params, url }) => {
	if (url.searchParams.get('confirm') !== 'true') {
		fail('VAULT_DELETE_CONFIRM_REQUIRED');
	}
	if (listVaults().length <= 1) {
		fail('VAULT_LAST_UNDELETABLE');
	}
	try {
		deleteChatsForVault(params.id);
		// Must close both cached DB connections BEFORE deleteVault removes the
		// vault's directory — Windows refuses to delete a file with an open
		// handle (EBUSY), and retrieve.ts/study-db.ts each cache one
		// better-sqlite3 connection per vault for the process lifetime.
		closeVaultIndexDb(params.id);
		closeVaultStudyDb(params.id);
		deleteVault(params.id);
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 500);
	}
	return json({ ok: true });
};
