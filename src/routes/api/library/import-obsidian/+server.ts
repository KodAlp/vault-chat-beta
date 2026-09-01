import type { RequestHandler } from './$types';
import { importObsidianVault } from '$lib/server/importObsidian';
import { vaultFromId } from '$lib/server/requestVault';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import type { ObsidianImportEvent } from '$lib/types';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { sourcePath: string; vault?: string };
	const v = vaultFromId(body.vault);

	// sseStream, not a bare ReadableStream — same crash this fixed for the
	// five /api/generate/* routes and for the other import routes: a large
	// Obsidian vault can take a while to walk/copy/index, and an abandoned
	// request used to throw an unhandled error out of the next send() and
	// take the whole server down instead of just this one request.
	return sseStream<ObsidianImportEvent>(async (send) => {
		try {
			send({ type: 'progress', stage: 'scanning' });
			const summary = await importObsidianVault(v, body.sourcePath, (item) => send({ type: 'item', item }));
			send({ type: 'done', summary });
		} catch (err) {
			send({ type: 'error', message: err instanceof Error ? err.message : 'Bilinmeyen hata' });
		}
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `obsidian import stream: ${message}` }));
};
