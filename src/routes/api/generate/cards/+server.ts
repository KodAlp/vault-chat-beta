import type { RequestHandler } from './$types';
import { generateCards } from '$lib/server/generate-cards';
import { vaultFromId } from '$lib/server/requestVault';
import { NoSourcesError } from '$lib/server/generate-errors';
import { logAppEvent } from '$lib/server/app-log';
import { sseStream } from '$lib/server/sse';
import type { CardGenerationEvent, CardGenerationRequest } from '$lib/types';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as CardGenerationRequest;
	const v = vaultFromId(body.vault);

	return sseStream<CardGenerationEvent>(
		async (send) => {
			try {
				const { deckId } = await generateCards(
					v,
					{
						domains: body.domains,
						chatId: body.chatId,
						prompt: body.prompt,
						count: body.count,
						model: body.model,
						provider: body.provider,
						includedPaths: body.includedPaths
					},
					(stage, elapsedMs) => send({ type: 'progress', stage, elapsedMs })
				);
				send({ type: 'done', deckId });
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Bilinmeyen hata';
				if (err instanceof NoSourcesError) {
					logAppEvent({
						kind: 'no_sources',
						generationType: 'cards',
						model: body.model,
						message,
						reason: err.reason
					});
				} else {
					logAppEvent({ kind: 'generation_error', generationType: 'cards', model: body.model, message });
				}
				send({
					type: 'error',
					message,
					narrowScope: err instanceof NoSourcesError ? err.narrowScope : undefined
				});
			}
		},
		(message) =>
			logAppEvent({ kind: 'generation_error', generationType: 'flashcards', model: body.model, message })
	);
};
