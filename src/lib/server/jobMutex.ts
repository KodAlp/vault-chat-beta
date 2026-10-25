/**
 * A promise queue with reader/writer semantics. `run()` is exclusive: it
 * only starts once everything queued before it has settled and nothing else
 * is running (Ollama model swaps, YouTube/web/link imports all use this).
 * `runShared()` jobs may overlap each other, up to a per-call limit, but
 * never overlap an exclusive job. Extracted from the conversion queue
 * so it can be shared with the Ollama model-swap logic: both are
 * CPU/RAM-bound work that must never run concurrently with each other on
 * this machine (the user RAM/CPU belongs to Ollama first, see the
 * model-provider skill doc). One shared instance, not one per subsystem.
 *
 * Ordering: ONE FIFO queue of exclusive and shared entries, and only the
 * head may start. A waiting exclusive job therefore blocks shared jobs
 * queued after it (writer preference): a model swap waits only for the
 * conversions already running, never for a whole queued batch.
 */
export interface JobMutex {
	run<T>(task: () => Promise<T>): Promise<T>;
	/** Shared slot: starts when no exclusive job is running and fewer than
	 * `limit` (clamped to >= 1) shared jobs are running. `runShared(t, 1)`
	 * is equivalent to `run(t)` among conversions. */
	runShared<T>(task: () => Promise<T>, limit: number): Promise<T>;
}

interface Entry {
	exclusive: boolean;
	limit: number;
	start: () => void;
}

export function createMutex(): JobMutex {
	const queue: Entry[] = [];
	let activeShared = 0;
	let activeExclusive = false;

	function pump(): void {
		while (queue.length > 0) {
			const head = queue[0];
			if (head.exclusive) {
				if (activeExclusive || activeShared > 0) return;
				activeExclusive = true;
			} else {
				if (activeExclusive || activeShared >= head.limit) return;
				activeShared++;
			}
			queue.shift();
			head.start();
		}
	}

	function enqueue<T>(task: () => Promise<T>, exclusive: boolean, limit: number): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			queue.push({
				exclusive,
				limit,
				start: () => {
					// Deferred by a microtask (like the old tail.then(task)) so a
					// synchronous throw becomes a rejection, never an escape.
					Promise.resolve()
						.then(task)
						.then(resolve, reject)
						.finally(() => {
							if (exclusive) activeExclusive = false;
							else activeShared--;
							pump();
						});
				}
			});
			pump();
		});
	}

	return {
		run: (task) => enqueue(task, true, 1),
		runShared: (task, limit) => enqueue(task, false, Math.max(1, Math.floor(limit) || 1))
	};
}

/** The one shared instance, see module doc comment above. */
export const sharedJobMutex: JobMutex = createMutex();
