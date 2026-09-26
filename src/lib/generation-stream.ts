/**
 * Shared fetch+SSE-parse loop for the five generation stores
 * (quiz/card/report/mindmap/slides-generation.svelte.ts). Before this, each
 * store hand-rolled an identical `while (true) { reader.read() ... }` loop
 * with no way to cancel an in-flight generation and no stall detection — a
 * wedged provider (or a model that never returns) left the store stuck on
 * 'generating' forever, with nothing the user could do but reload the page.
 *
 * Two concerns folded in here because every store needs both, identically:
 *
 *  - Cancellation: the caller owns an AbortController per in-flight
 *    generation (keyed by its own client-side id) and passes it in here.
 *    Aborting it (via the store's exported cancelXGeneration(id)) stops the
 *    fetch/stream. This is reported back as `{ kind: 'cancelled' }`, NEVER
 *    as an error — a user-initiated cancel must not show an error toast.
 *
 *  - Idle watchdog: the server heartbeats every ~10s during a model call
 *    (see generate-{quiz,cards,report,mindmap,slides}.ts's
 *    HEARTBEAT_INTERVAL_MS, forwarded as `progress` events with a bumped
 *    `elapsedMs`), so ANY chunk read from the stream — heartbeat or real
 *    progress — resets a 120s idle timer. If 120s pass with no chunk at
 *    all, the stream is aborted and reported as `{ kind: 'stalled' }`. This
 *    is idle-based, not a total-time cap: a long local generation that
 *    keeps producing heartbeats never trips it.
 */
const IDLE_TIMEOUT_MS = 120_000;

export type GenerationStreamResult =
	| { kind: 'ok' }
	| { kind: 'cancelled' }
	| { kind: 'stalled' }
	/** The stream closed cleanly but never sent a `done` or `error` event —
	 * e.g. the server route died past its own try/catch. Without this the
	 * entry would sit on 'generating' forever. */
	| { kind: 'incomplete' }
	/** fetch resolved but with a non-ok status (or no body) — the caller
	 * reads the error out of `response` itself (see server-error.ts's
	 * readResponseError), since only it knows its own event/status shape. */
	| { kind: 'bad-response'; response: Response }
	/** The fetch itself threw for a reason that wasn't this controller's own
	 * abort — a network failure, a body that wasn't valid SSE, etc. */
	| { kind: 'fetch-error'; err: unknown };

/**
 * Runs one POST + SSE-parse loop against `url`. `onEvent` is called once per
 * `data: ...` line, in order, exactly as the old inline loops did — the
 * caller narrows `event.type` itself since each store's event union differs
 * only in its `done` variant.
 */
export async function runGenerationStream<E>(
	url: string,
	body: unknown,
	controller: AbortController,
	onEvent: (event: E) => void
): Promise<GenerationStreamResult> {
	let stalledLocally = false;
	let sawTerminal = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const armIdleTimer = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			stalledLocally = true;
			controller.abort();
		}, IDLE_TIMEOUT_MS);
	};
	const clearIdleTimer = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
	};

	try {
		armIdleTimer();
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: controller.signal
		});
		if (!res.ok || !res.body) {
			return { kind: 'bad-response', response: res };
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			// A chunk arrived — including a bare heartbeat — so the stream is
			// alive; reset the idle window.
			armIdleTimer();
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split('\n\n');
			buffer = parts.pop() ?? '';
			for (const part of parts) {
				const line = part.trim();
				if (!line.startsWith('data:')) continue;
				const event = JSON.parse(line.slice(5)) as E;
				const type = (event as { type?: unknown }).type;
				if (type === 'done' || type === 'error') sawTerminal = true;
				onEvent(event);
			}
		}
		return sawTerminal ? { kind: 'ok' } : { kind: 'incomplete' };
	} catch (err) {
		if (controller.signal.aborted) {
			return stalledLocally ? { kind: 'stalled' } : { kind: 'cancelled' };
		}
		return { kind: 'fetch-error', err };
	} finally {
		clearIdleTimer();
	}
}
