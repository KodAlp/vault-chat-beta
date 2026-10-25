import type { RequestHandler } from './$types';
import { deleteSmallTalk } from '#lib/server/smalltalk-runtime.js';
import { fail } from '#lib/server/app-error.js';

/** Removes a learned phrase; a built-in seed is switched off instead of deleted. */
export const DELETE: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id < 1) fail('VALIDATION_INVALID', { field: 'id' });
	if (!deleteSmallTalk(id)) fail('NOT_FOUND', { entity: 'record' }, 404);
	return Response.json({ ok: true });
};
