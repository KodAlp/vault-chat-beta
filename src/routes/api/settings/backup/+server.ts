import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runBackup, defaultBackupDestination, validateBackupDestination } from '$lib/server/backup';
import { sseStream } from '$lib/server/sse';
import { AppError, errorPayload, fail } from '$lib/server/app-error';
import { logAppEvent } from '$lib/server/app-log';
import type { BackupEvent } from '$lib/types';

/**
 * #61 - data backup. An ordinary session-gated /api/settings route (never under /api/mcp/, so an MCP client
 * cannot make the app write files anywhere it likes).
 *
 * GET  -> { defaultDestination } for the settings card's prefilled field.
 * POST { destination } -> SSE: 'start' / 'progress' / 'done' (folder, ok, counts, failed) / 'cancelled' / 'error'.
 *      Same stream shape as /api/vaults/[id]/reindex; a client disconnect cancels the copy and removes the
 *      half-written folder. A destination that is invalid is rejected up front as a plain coded 400, before
 *      any stream starts.
 */
export const GET: RequestHandler = async () => {
	return json({ defaultDestination: defaultBackupDestination() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { destination?: unknown } | null;
	const destination = typeof body?.destination === 'string' ? body.destination : '';
	try {
		validateBackupDestination(destination);
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		throw err;
	}

	return sseStream<BackupEvent>(
		async (send) => {
			let sentStart = false;
			try {
				const result = await runBackup({
					destination,
					signal: request.signal,
					onProgress: (p) => {
						if (!sentStart) {
							send({ type: 'start', total: p.total });
							sentStart = true;
						}
						send({ type: 'progress', done: p.done, total: p.total, path: p.path });
					}
				});
				send({
					type: 'done',
					folder: result.folder,
					ok: result.ok,
					files: result.manifest.counts.files,
					databases: result.manifest.counts.databases,
					bytes: result.manifest.counts.bytes,
					failed: result.manifest.failed.slice(0, 20)
				});
			} catch (err) {
				if (err instanceof DOMException && err.name === 'AbortError') {
					send({ type: 'cancelled' });
				} else {
					send({ type: 'error', ...errorPayload(err) });
				}
			}
		},
		(message) => logAppEvent({ kind: 'fatal_error', message: `backup stream: ${message}` })
	);
};
