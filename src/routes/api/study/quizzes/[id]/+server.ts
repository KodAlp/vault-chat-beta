import type { RequestHandler } from './$types';
import { getQuiz, getQuizItems, deleteQuiz } from '#lib/server/study-db.js';
import { vaultFromUrl, vaultFromId } from '#lib/server/requestVault.js';
import { fail } from '#lib/server/app-error.js';
import type { QuizItemView, QuizView } from '#lib/types.js';

export const GET: RequestHandler = async ({ params, url }) => {
	const v = vaultFromUrl(url);
	const quiz = getQuiz(v, params.id);
	if (!quiz) fail('NOT_FOUND', { entity: 'quiz' }, 404);

	// No answer/explanation here on purpose — the UI rule is "no answer
	// reveal until submitted". Those come back from the attempt-submit endpoint.
	// A question the user flagged as faulty is not asked again.
	const items: QuizItemView[] = getQuizItems(v, params.id)
		.filter((row) => row.flagged_at === null)
		.map((row) => ({
		id: row.id,
		type: row.type,
		question: row.question,
		options: row.options_json ? (JSON.parse(row.options_json) as string[]) : null,
		source_path: row.source_path,
		heading_path: row.heading_path
	}));

	const view: QuizView = { id: quiz.id, title: quiz.title, model: quiz.model };
	return Response.json({ quiz: view, items });
};

export const DELETE: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as { vault?: string };
	const v = vaultFromId(body.vault);
	if (!getQuiz(v, params.id)) fail('NOT_FOUND', { entity: 'quiz' }, 404);
	deleteQuiz(v, params.id);
	return Response.json({ ok: true });
};
