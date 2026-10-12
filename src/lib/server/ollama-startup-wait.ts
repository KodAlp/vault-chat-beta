/**
 * #87 — the desktop shell starts the local Ollama in the background at app
 * launch (src-tauri/src/launchers.rs startup()), so for the first seconds a
 * request can arrive before the port answers. Connection-level failures
 * (nothing listening yet) against a LOOPBACK Ollama are therefore retried for
 * a bounded window instead of surfacing immediately as EMBEDDING_UNAVAILABLE /
 * indexPending. HTTP errors (the server answered) and non-loopback hosts are
 * never retried. Runs in the MCP process too (no $env imports).
 */
export const STARTUP_WAIT_MS = 30_000;
const RETRY_EVERY_MS = 1_000;

export function isLoopbackUrl(url: string): boolean {
	try {
		const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
		return h === 'localhost' || h === '127.0.0.1' || h === '::1';
	} catch {
		return false;
	}
}

/** fetch() rejects with a TypeError (cause ECONNREFUSED etc.) when nothing is listening; an AbortError/timeout is not that. */
function isConnectionFailure(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
	return err instanceof TypeError;
}

export interface StartupWaitDeps {
	fetchFn?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	waitMs?: number;
}

export async function fetchWithStartupWait(url: string, init: RequestInit, deps: StartupWaitDeps = {}): Promise<Response> {
	const fetchFn = deps.fetchFn ?? fetch;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = deps.now ?? Date.now;
	const deadline = now() + (deps.waitMs ?? STARTUP_WAIT_MS);
	const retryable = isLoopbackUrl(url);
	for (;;) {
		try {
			return await fetchFn(url, init);
		} catch (err) {
			if (!retryable || !isConnectionFailure(err) || now() >= deadline) throw err;
			await sleep(RETRY_EVERY_MS);
		}
	}
}
