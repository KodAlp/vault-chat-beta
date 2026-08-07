import type { RequestHandler } from './$types';
import { generateQuiz } from '$lib/server/generate-quiz';
import { vaultFromId } from '$lib/server/requestVault';
import { NoSourcesError } from '$lib/server/generate-errors';
import type { QuizGenerationEvent, QuizGenerationRequest } from '$lib/types';

function sseEvent(event: QuizGenerationEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as QuizGenerationRequest;
	const v = vaultFromId(body.vault);

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: QuizGenerationEvent) =>
				controller.enqueue(encoder.encode(sseEvent(event)));

			try {
				const { quizId } = await generateQuiz(
					v,
					{
						domains: body.domains,
						chatId: body.chatId,
						prompt: body.prompt,
						composition: body.composition,
						model: body.model,
						includedPaths: body.includedPaths
					},
					(stage) => send({ type: 'progress', stage })
				);
				send({ type: 'done', quizId });
			} catch (err) {
				send({
					type: 'error',
					message: err instanceof Error ? err.message : 'Bilinmeyen hata',
					narrowScope: err instanceof NoSourcesError ? err.narrowScope : undefined
				});
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
};
