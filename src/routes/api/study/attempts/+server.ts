import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getQuiz, createAttempt } from '$lib/server/study-db';
import { vaultFromId } from '$lib/server/requestVault';
import { fail } from '$lib/server/app-error';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { quizId: string; vault?: string };
	const v = vaultFromId(body.vault);
	if (!getQuiz(v, body.quizId)) fail('NOT_FOUND', { entity: 'quiz' }, 404);

	const attemptId = createAttempt(v, body.quizId);
	return json({ attemptId });
};
