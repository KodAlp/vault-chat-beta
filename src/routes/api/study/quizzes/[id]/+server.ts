import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getQuiz, getQuizItems } from '$lib/server/study-db';
import type { QuizItemView, QuizView } from '$lib/types';

export const GET: RequestHandler = async ({ params }) => {
	const quiz = getQuiz(params.id);
	if (!quiz) error(404, 'Sınav bulunamadı');

	// No answer/explanation here on purpose — the skill's UI spec is "no answer
	// reveal until submitted". Those come back from the attempt-submit endpoint.
	const items: QuizItemView[] = getQuizItems(params.id).map((row) => ({
		id: row.id,
		type: row.type,
		question: row.question,
		options: row.options_json ? (JSON.parse(row.options_json) as string[]) : null,
		source_path: row.source_path,
		heading_path: row.heading_path
	}));

	const view: QuizView = { id: quiz.id, title: quiz.title, model: quiz.model };
	return json({ quiz: view, items });
};
