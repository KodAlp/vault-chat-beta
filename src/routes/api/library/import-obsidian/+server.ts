import type { RequestHandler } from './$types';
import { importObsidianVault } from '$lib/server/importObsidian';
import { protectedDirsFor } from '$lib/server/library-import/service';
import { dataDir } from '$lib/server/env';
import { vaultFromId } from '$lib/server/requestVault';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import { errorPayload } from '$lib/server/app-error';
import type { LibraryImportEvent } from '$lib/types';

/**
 * Kept as a thin wrapper (Markdown-folder adapter, scan + run in one step) for
 * anything still calling the old endpoint; the Library import page uses
 * /api/library/import-source/{scan,run} instead.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { sourcePath: string; vault?: string };
	const v = vaultFromId(body.vault);

	// sseStream, not a bare ReadableStream — same crash this fixed for the
	// five /api/generate/* routes and for the other import routes: a large
	// vault can take a while to walk/copy/index, and an abandoned
	// request used to throw an unhandled error out of the next send() and
	// take the whole server down instead of just this one request.
	return sseStream<LibraryImportEvent>(async (send) => {
		try {
			send({ type: 'progress', stage: 'scanning' });
			const summary = await importObsidianVault(v, body.sourcePath, (item) => send({ type: 'item', item }), {
				protectedDirs: protectedDirsFor(v, dataDir())
			});
			send({ type: 'done', summary });
		} catch (err) {
			send({ type: 'error', ...errorPayload(err) });
		}
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `obsidian import stream: ${message}` }));
};
