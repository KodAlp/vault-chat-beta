import type { RequestHandler } from './$types';
import { generateSlides } from '$lib/server/generate-slides';
import { vaultFromId } from '$lib/server/requestVault';
import { NoSourcesError } from '$lib/server/generate-errors';
import { logAppEvent } from '$lib/server/app-log';
import { sseStream } from '$lib/server/sse';
import type { SlidesGenerationEvent, SlidesGenerationRequest } from '$lib/types';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as SlidesGenerationRequest;
	const v = vaultFromId(body.vault);

	return sseStream<SlidesGenerationEvent>(
		async (send) => {
			try {
				const { slideDeckId } = await generateSlides(
					v,
					{
						domains: body.domains,
						chatId: body.chatId,
						prompt: body.prompt,
						model: body.model,
						provider: body.provider,
						includedPaths: body.includedPaths
					},
					(stage, elapsedMs) => send({ type: 'progress', stage, elapsedMs })
				);
				send({ type: 'done', slideDeckId });
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Bilinmeyen hata';
				if (err instanceof NoSourcesError) {
					logAppEvent({
						kind: 'no_sources',
						generationType: 'slides',
						model: body.model,
						message,
						reason: err.reason
					});
				} else {
					logAppEvent({ kind: 'generation_error', generationType: 'slides', model: body.model, message });
				}
				send({
					type: 'error',
					message,
					narrowScope: err instanceof NoSourcesError ? err.narrowScope : undefined
				});
			}
		},
		(message) =>
			logAppEvent({ kind: 'generation_error', generationType: 'slides', model: body.model, message })
	);
};
