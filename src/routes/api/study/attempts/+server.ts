import type { RequestHandler } from './$types';
import { getQuiz, createAttempt } from '#lib/server/study-db.js';
import { vaultFromId } from '#lib/server/requestVault.js';
import { fail } from '#lib/server/app-error.js';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { quizId: string; vault?: string };
	const v = vaultFromId(body.vault);
	if (!getQuiz(v, body.quizId)) fail('NOT_FOUND', { entity: 'quiz' }, 404);

	const attemptId = createAttempt(v, body.quizId);
	return Response.json({ attemptId });
};
