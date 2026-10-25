import type { RequestHandler } from './$types';
import { generateReport } from '#lib/server/generate-report.js';
import { vaultFromId } from '#lib/server/requestVault.js';
import { NoSourcesError } from '#lib/server/generate-errors.js';
import { logAppEvent } from '#lib/server/app-log.js';
import { sseStream } from '#lib/server/sse.js';
import { errorPayload } from '#lib/server/app-error.js';
import type { ReportGenerationEvent, ReportGenerationRequest } from '#lib/types.js';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as ReportGenerationRequest;
	const v = vaultFromId(body.vault);

	return sseStream<ReportGenerationEvent>(
		async (send) => {
			try {
				const { reportId } = await generateReport(
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
				send({ type: 'done', reportId });
			} catch (err) {
				const coded = errorPayload(err);
				if (err instanceof NoSourcesError) {
					logAppEvent({
						kind: 'no_sources',
						generationType: 'report',
						model: body.model,
						message: coded.code,
						reason: err.reason
					});
				} else {
					logAppEvent({ kind: 'generation_error', generationType: 'report', model: body.model, message: coded.code });
				}
				send({
					type: 'error',
					...coded,
					narrowScope: err instanceof NoSourcesError ? err.narrowScope : undefined
				});
			}
		},
		(message) =>
			logAppEvent({ kind: 'generation_error', generationType: 'report', model: body.model, message })
	);
};
