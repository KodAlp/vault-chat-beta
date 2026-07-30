/**
 * Server-side single-flight per chat, independent of any one client
 * connection's own AbortSignal. Eliminates the duplicate-generation race:
 * a new message for a chat that's still streaming (a second tab, a retry,
 * a flaky connection that never sent an abort) aborts the stale flight
 * before starting a new one, rather than letting two upstream requests
 * for the same chat run concurrently.
 */
const inflight = new Map<string, AbortController>();

/** Aborts any existing flight for this chat, registers and returns a fresh one. */
export function startFlight(chatId: string): AbortController {
	inflight.get(chatId)?.abort();
	const controller = new AbortController();
	inflight.set(chatId, controller);
	return controller;
}

/** Only clears the entry if it's still the one we started — a superseded
 * flight's own cleanup must never delete the flight that replaced it. */
export function endFlight(chatId: string, controller: AbortController): void {
	if (inflight.get(chatId) === controller) inflight.delete(chatId);
}
