import type { RequestHandler } from './$types';
import { generateQuiz } from '$lib/server/generate-quiz';
import { vaultFromId } from '$lib/server/requestVault';
import { NoSourcesError } from '$lib/server/generate-errors';
import { logAppEvent } from '$lib/server/app-log';
import { sseStream } from '$lib/server/sse';
import type { QuizGenerationEvent, QuizGenerationRequest } from '$lib/types';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as QuizGenerationRequest;
	const v = vaultFromId(body.vault);

	return sseStream<QuizGenerationEvent>(
		async (send) => {
			try {
				const { quizId, requested, delivered } = await generateQuiz(
					v,
					{
						domains: body.domains,
						chatId: body.chatId,
						prompt: body.prompt,
						composition: body.composition,
						model: body.model,
						provider: body.provider,
						includedPaths: body.includedPaths,
						// only an explicit true turns the experimental labels on
						levels: body.levels === true
					},
					(stage, elapsedMs) => send({ type: 'progress', stage, elapsedMs })
				);
				send({ type: 'done', quizId, requested, delivered });
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Bilinmeyen hata';
				if (err instanceof NoSourcesError) {
					logAppEvent({
						kind: 'no_sources',
						generationType: 'quiz',
						model: body.model,
						message,
						reason: err.reason
					});
				} else {
					logAppEvent({ kind: 'generation_error', generationType: 'quiz', model: body.model, message });
				}
				send({
					type: 'error',
					message,
					narrowScope: err instanceof NoSourcesError ? err.narrowScope : undefined
				});
			}
		},
		(message) =>
			logAppEvent({ kind: 'generation_error', generationType: 'quiz', model: body.model, message })
	);
};
