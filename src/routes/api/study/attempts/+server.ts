import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getQuiz, createAttempt } from '$lib/server/study-db';
import { vaultFromId } from '$lib/server/requestVault';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { quizId: string; vault?: string };
	const v = vaultFromId(body.vault);
	if (!getQuiz(v, body.quizId)) error(404, 'Sınav bulunamadı');

	const attemptId = createAttempt(v, body.quizId);
	return json({ attemptId });
};
