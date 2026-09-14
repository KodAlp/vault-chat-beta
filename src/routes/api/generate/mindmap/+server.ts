import type { RequestHandler } from './$types';
import { generateMindMap } from '$lib/server/generate-mindmap';
import { vaultFromId } from '$lib/server/requestVault';
import { NoSourcesError } from '$lib/server/generate-errors';
import { logAppEvent } from '$lib/server/app-log';
import { sseStream } from '$lib/server/sse';
import type { MindMapGenerationEvent, MindMapGenerationRequest } from '$lib/types';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as MindMapGenerationRequest;
	const v = vaultFromId(body.vault);

	return sseStream<MindMapGenerationEvent>(
		async (send) => {
			try {
				const { mindmapId } = await generateMindMap(
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
				send({ type: 'done', mindmapId });
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Bilinmeyen hata';
				if (err instanceof NoSourcesError) {
					logAppEvent({
						kind: 'no_sources',
						generationType: 'mindmap',
						model: body.model,
						message,
						reason: err.reason
					});
				} else {
					logAppEvent({ kind: 'generation_error', generationType: 'mindmap', model: body.model, message });
				}
				send({
					type: 'error',
					message,
					narrowScope: err instanceof NoSourcesError ? err.narrowScope : undefined
				});
			}
		},
		(message) =>
			logAppEvent({ kind: 'generation_error', generationType: 'mindmap', model: body.model, message })
	);
};
