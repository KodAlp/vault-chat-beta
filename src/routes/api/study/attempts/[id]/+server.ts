import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getAttempt,
	getQuizItem,
	insertAttemptAnswer,
	finishAttempt
} from '$lib/server/study-db';
import { gradeOpenAnswer } from '$lib/server/grade-open';
import { isAnswered } from '$lib/study-answers';
import { vaultFromId } from '$lib/server/requestVault';
import type { AttemptResultItem, SubmitAttemptRequest, SubmitAttemptResponse } from '$lib/types';

export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as SubmitAttemptRequest;
	const v = vaultFromId(body.vault);

	const attempt = getAttempt(v, params.id);
	if (!attempt) error(404, 'Deneme bulunamadı');

	const results: AttemptResultItem[] = [];
	let correctCount = 0;

	for (const answer of body.answers) {
		const item = getQuizItem(v, answer.itemId);
		if (!item || item.quiz_id !== attempt.quiz_id) continue;

		let isCorrect: boolean;
		let modelFeedback: string | null = null;

		if (!isAnswered(answer.given)) {
			// Skipped: the page sends every question on finish, blanks included. A blank is never
			// correct and never goes to the model — it used to, and the grader approved 6 of 21 blank
			// open answers ("Doğru cevap!" for an answer nobody wrote). See study-answers.ts.
			isCorrect = false;
		} else if (item.type === 'open') {
			// Never graded by code — the skill requires the model here, clearly
			// labeled in the UI as "model değerlendirmesi".
			const grade = await gradeOpenAnswer(
				item.question,
				item.answer,
				answer.given,
				body.fastModel,
				body.fastProvider
			);
			isCorrect = grade.correct;
			modelFeedback = grade.feedback;
		} else {
			// MC/TF: always graded in code, never by the model.
			isCorrect = answer.given.trim() === item.answer.trim();
		}

		if (isCorrect) correctCount++;

		insertAttemptAnswer(v, {
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
	finishAttempt(v, attempt.id, score);

	const response: SubmitAttemptResponse = { score, items: results };
	return json(response);
};
