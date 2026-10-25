import type { RequestHandler } from './$types';
import { getQuizItem, setQuizItemFlagged } from '#lib/server/study-db.js';
import { vaultFromId } from '#lib/server/requestVault.js';
import { fail } from '#lib/server/app-error.js';

/**
 * "Bu soru hatalı": the user marks a generated question as faulty (a wrong answer key, an ambiguous or source-specific
 * question). Generated quizzes come from a small local model — a hand-read sample of 36 had 1 definitely wrong key and
 * about 1 in 9 questions faulty — and only the person answering can tell. A flagged question is not asked again, drops out
 * of the score shown, and is not counted as learning evidence. Reversible: `flagged: false`.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as { vault?: string; flagged?: unknown };
	if (typeof body.flagged !== 'boolean') fail('VALIDATION_REQUIRED', { field: 'flagged' });
	const v = vaultFromId(body.vault);
	const item = getQuizItem(v, params.itemId);
	if (!item || item.quiz_id !== params.id) fail('NOT_FOUND', { entity: 'question' }, 404);
	setQuizItemFlagged(v, item.id, body.flagged);
	return Response.json({ ok: true, flagged: body.flagged });
};
