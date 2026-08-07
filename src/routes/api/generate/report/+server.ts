import type { RequestHandler } from './$types';
import { generateReport } from '$lib/server/generate-report';
import { vaultFromId } from '$lib/server/requestVault';
import { NoSourcesError } from '$lib/server/generate-errors';
import type { ReportGenerationEvent, ReportGenerationRequest } from '$lib/types';

function sseEvent(event: ReportGenerationEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as ReportGenerationRequest;
	const v = vaultFromId(body.vault);

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: ReportGenerationEvent) =>
				controller.enqueue(encoder.encode(sseEvent(event)));

			try {
				const { reportId } = await generateReport(
					v,
					{
						domains: body.domains,
						chatId: body.chatId,
						prompt: body.prompt,
						model: body.model,
						includedPaths: body.includedPaths
					},
					(stage) => send({ type: 'progress', stage })
				);
				send({ type: 'done', reportId });
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
