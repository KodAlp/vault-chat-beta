/**
 * A generic single-flight promise queue: whatever's `run()` is called with
 * next only starts once everything queued before it has settled. Extracted
 * from Faz 5's conversion queue so it can be shared with Faz 6's Ollama
 * model-swap logic — both are CPU/RAM-bound work that must never run
 * concurrently with each other on this machine ("the user's RAM/CPU
 * belongs to Ollama first" — model-provider skill doc). One shared
 * instance, not one per subsystem.
 */
export interface JobMutex {
	run<T>(task: () => Promise<T>): Promise<T>;
}

export function createMutex(): JobMutex {
	let tail: Promise<unknown> = Promise.resolve();

	function run<T>(task: () => Promise<T>): Promise<T> {
		const result = tail.then(task, task);
		// Swallow rejection for chaining purposes only — the real result/error
		// still propagates to this call's own caller via the returned promise.
		tail = result.catch(() => undefined);
		return result;
	}

	return { run };
}

/** The one shared instance — see module doc comment above. */
export const sharedJobMutex: JobMutex = createMutex();
