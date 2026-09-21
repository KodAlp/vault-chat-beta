import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteSmallTalk } from '$lib/server/smalltalk-runtime';

/** Removes a learned phrase; a built-in seed is switched off instead of deleted. */
export const DELETE: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id < 1) error(400, 'Geçersiz id');
	if (!deleteSmallTalk(id)) error(404, 'Kayıt bulunamadı');
	return json({ ok: true });
};
