/**
 * SSE response shell shared by the five /api/generate/* endpoints.
 *
 * Extracted because all five had the same stream boilerplate AND the same
 * crash in it: `send` called `controller.enqueue` unconditionally, so once
 * the client went away (closed tab, navigation, a timed-out request) the
 * next event threw `ERR_INVALID_STATE: Controller is already closed`. That
 * throw came from the elapsedMs heartbeat's setInterval, i.e. from a timer
 * callback with no caller to catch it, which makes it an uncaughtException
 * that takes the whole Node process down — one abandoned generation killed
 * the server for everyone.
 *
 * So `send` is a no-op after the stream is done, whether it ended normally
 * or the client cancelled. The generation itself is deliberately left to run
 * to completion rather than aborted: its result is still written to study.db
 * and stays reachable from the study panel, which is what a user who
 * navigated away mid-generation would expect to find.
 */
export function sseStream<E>(
	run: (send: (event: E) => void) => Promise<void>,
	onInternalError?: (message: string) => void
): Response {
	let closed = false;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: E) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				} catch {
					// Lost the race with cancel(); nothing to do but stop trying.
					closed = true;
				}
			};

			try {
				await run(send);
			} catch (err) {
				// run() is expected to handle its own errors and report them as
				// an event. Reaching here means it did not, and an unhandled
				// rejection inside start() is another way to lose the process.
				onInternalError?.(err instanceof Error ? err.message : String(err));
			} finally {
				closed = true;
				try {
					controller.close();
				} catch {
					// Already closed by cancel() — expected, not an error.
				}
			}
		},
		cancel() {
			closed = true;
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
}
