/**
 * Runs `worker` over `items` with at most `limit` in flight at once. Workers
 * start in input order; results are returned in input order regardless of
 * completion order. A worker that throws rejects the pool only after the
 * in-flight ones settle (no new items start once one has failed) — callers
 * that want per-item isolation should catch inside the worker.
 */
export async function runPool<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failed = false;
	let firstError: unknown;
	const lane = async () => {
		while (!failed) {
			const i = next++;
			if (i >= items.length) return;
			try {
				results[i] = await worker(items[i], i);
			} catch (err) {
				if (!failed) {
					failed = true;
					firstError = err;
				}
				return;
			}
		}
	};
	const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
	await Promise.all(Array.from({ length: lanes }, lane));
	if (failed) throw firstError;
	return results;
}
