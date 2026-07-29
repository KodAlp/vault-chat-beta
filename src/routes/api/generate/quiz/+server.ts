import type { RequestHandler } from './$types';
import { generateQuiz } from '$lib/server/generate-quiz';
import type { QuizGenerationEvent, QuizGenerationRequest } from '$lib/types';

function sseEvent(event: QuizGenerationEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as QuizGenerationRequest;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: QuizGenerationEvent) =>
				controller.enqueue(encoder.encode(sseEvent(event)));

			try {
				const { quizId } = await generateQuiz(
					{
						domains: body.domains,
						chatId: body.chatId,
						prompt: body.prompt,
						composition: body.composition,
						model: body.model
					},
					(stage) => send({ type: 'progress', stage })
				);
				send({ type: 'done', quizId });
			} catch (err) {
				send({ type: 'error', message: err instanceof Error ? err.message : 'Bilinmeyen hata' });
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
