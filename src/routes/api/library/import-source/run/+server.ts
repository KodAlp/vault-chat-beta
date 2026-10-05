import type { RequestHandler } from './$types';
import { vaultFromId } from '$lib/server/requestVault';
import { runScanned } from '$lib/server/library-import/service';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import { errorPayload } from '$lib/server/app-error';
import type { LibraryImportEvent } from '$lib/types';

/**
 * Step 2: import the plan a previous scan recorded. SSE stream with the same
 * event shapes the Obsidian import always had (an item per note, then done).
 * An unknown or expired scanId is SCAN_EXPIRED, an adapter that differs from
 * the scan's is IMPORT_ADAPTER_MISMATCH — both arrive as an error event.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		scanId?: unknown;
		adapter?: unknown;
		targetPrefix?: unknown;
		vault?: string;
	};
	const v = vaultFromId(body.vault);

	// sseStream, not a bare ReadableStream: an abandoned request must not throw out of the
	// next send() and take the server down (same reasoning as the other import routes).
	return sseStream<LibraryImportEvent>(async (send) => {
		try {
			send({ type: 'progress', stage: 'importing' });
			const summary = await runScanned(v, body.scanId, {
				adapter: body.adapter,
				targetPrefix: body.targetPrefix,
				onProgress: (item) => send({ type: 'item', item })
			});
			send({ type: 'done', summary });
		} catch (err) {
			send({ type: 'error', ...errorPayload(err) });
		}
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `library import stream: ${message}` }));
};
