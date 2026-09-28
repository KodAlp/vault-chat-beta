import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveVault } from '$lib/server/vaults';
import { reindexVault, cancelReindex } from '$lib/server/reindex';
import { sseStream } from '$lib/server/sse';
import { AppError, errorPayload, fail, toCodedError } from '$lib/server/app-error';
import { logAppEvent } from '$lib/server/app-log';
import type { ErrorCode } from '$lib/errors';
import type { ReindexEvent } from '$lib/types';

/**
 * Aşama 3b — full, in-process rebuild of one vault's index under the
 * currently configured embedding (src/lib/server/reindex.ts does the actual
 * temp-file-then-atomic-swap work; indexer/rebuild.ts is the shared
 * walk/embed/write loop the CLI's `npm run index -- --full` also uses).
 *
 * No UI consumes this yet (Aşama 3c) — this route settles the server
 * contract: SSE 'start' (total files) / 'progress' (done/total/path) /
 * 'done' (files/chunks/ms) / 'cancelled' / 'error' (coded), same shape as
 * every other long-running action in this app (see /api/import,
 * generation-stream.ts).
 */
function sseErrorResponse(err: unknown): Response {
	return new Response(`data: ${JSON.stringify({ type: 'error', ...errorPayload(err) } satisfies ReindexEvent)}\n\n`, {
		headers: { 'content-type': 'text/event-stream' }
	});
}

export const POST: RequestHandler = async ({ params, request }) => {
	let v;
	try {
		v = resolveVault(params.id);
	} catch (err) {
		return sseErrorResponse(err);
	}

	return sseStream<ReindexEvent>(
		async (send) => {
			let sentStart = false;
			try {
				const stats = await reindexVault(v, {
					signal: request.signal,
					onProgress: (p) => {
						if (!sentStart) {
							send({ type: 'start', total: p.total });
							sentStart = true;
						}
						// The final onProgress call (done===total) carries path:'' to
						// mean "walk finished, wrapping up" (see rebuild.ts) — not a
						// real file, so it gets no 'progress' event of its own; the
						// 'done' event right after this covers that moment instead.
						if (p.path) send({ type: 'progress', done: p.done, total: p.total, path: p.path });
					}
				});
				send({ type: 'done', files: stats.files, chunks: stats.chunks, ms: stats.ms });
			} catch (err) {
				// A cancel (DELETE on this same route) or the client disconnecting
				// (request.signal) surfaces here as AbortError — not a failure, same
				// posture as api/chat/+server.ts's own abort handling.
				if (err instanceof DOMException && err.name === 'AbortError') {
					send({ type: 'cancelled' });
				} else {
					send({ type: 'error', ...errorPayload(err) });
				}
			}
		},
		(message) => logAppEvent({ kind: 'fatal_error', message: `reindex stream (${v.id}): ${message}` })
	);
};

/** Cancels an in-progress reindex for this vault — a no-op (still 200,
 * `cancelled: false`) if none is running, mirroring the forgiving shape of
 * /api/library/import/[id]/cancel (deleting an already-gone staged file is
 * also harmless there). */
export const DELETE: RequestHandler = async ({ params }) => {
	try {
		const v = resolveVault(params.id);
		return json({ cancelled: cancelReindex(v.id) });
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 404);
	}
};
