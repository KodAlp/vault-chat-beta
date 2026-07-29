import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getQuiz, createAttempt } from '$lib/server/study-db';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { quizId: string };
	if (!getQuiz(body.quizId)) error(404, 'Sınav bulunamadı');

	const attemptId = createAttempt(body.quizId);
	return json({ attemptId });
};
