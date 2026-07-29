import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getAttempt,
	getQuizItem,
	insertAttemptAnswer,
	finishAttempt
} from '$lib/server/study-db';
import { gradeOpenAnswer } from '$lib/server/grade-open';
import type { AttemptResultItem, SubmitAttemptRequest, SubmitAttemptResponse } from '$lib/types';

export const PATCH: RequestHandler = async ({ params, request }) => {
	const attempt = getAttempt(params.id);
	if (!attempt) error(404, 'Deneme bulunamadı');

	const body = (await request.json()) as SubmitAttemptRequest;
	const results: AttemptResultItem[] = [];
	let correctCount = 0;

	for (const answer of body.answers) {
		const item = getQuizItem(answer.itemId);
		if (!item || item.quiz_id !== attempt.quiz_id) continue;

		let isCorrect: boolean;
		let modelFeedback: string | null = null;

		if (item.type === 'open') {
			// Never graded by code — the skill requires the model here, clearly
			// labeled in the UI as "model değerlendirmesi".
			const grade = await gradeOpenAnswer(item.question, item.answer, answer.given, body.fastModel);
			isCorrect = grade.correct;
			modelFeedback = grade.feedback;
		} else {
			// MC/TF: always graded in code, never by the model.
			isCorrect = answer.given.trim() === item.answer.trim();
		}

		if (isCorrect) correctCount++;

		insertAttemptAnswer({
			attemptId: attempt.id,
			itemId: item.id,
			given: answer.given,
			isCorrect,
			modelFeedback
		});

		results.push({
			itemId: item.id,
			question: item.question,
			type: item.type,
			options: item.options_json ? (JSON.parse(item.options_json) as string[]) : null,
			given: answer.given,
			correctAnswer: item.answer,
			explanation: item.explanation,
			isCorrect,
			modelFeedback,
			sourcePath: item.source_path,
			headingPath: item.heading_path
		});
	}

	const score = body.answers.length > 0 ? correctCount / body.answers.length : 0;
	finishAttempt(attempt.id, score);

	const response: SubmitAttemptResponse = { score, items: results };
	return json(response);
};
