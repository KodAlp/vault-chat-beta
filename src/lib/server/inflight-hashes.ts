/**
 * In-process "currently being imported" reservations, keyed per vault by the
 * source file's sha256. Batch import can run several requests in parallel;
 * each one's already-imported check reads the import log, which is only
 * appended AFTER conversion — two identical files in flight at once would
 * both pass it. Reserve before converting, release in a finally (after the
 * log append), and the second one is reported as skipped.
 *
 * reserve() is synchronous, so a check-then-reserve with no await in between
 * cannot interleave with another request.
 */
export interface InflightHashes {
	/** True if newly reserved; false if the same hash is already in flight for that vault. */
	reserve(vaultId: string, sha256: string): boolean;
	release(vaultId: string, sha256: string): void;
}

export function createInflightHashes(): InflightHashes {
	const held = new Map<string, Set<string>>();
	return {
		reserve(vaultId, sha256) {
			let set = held.get(vaultId);
			if (!set) {
				set = new Set();
				held.set(vaultId, set);
			}
			if (set.has(sha256)) return false;
			set.add(sha256);
			return true;
		},
		release(vaultId, sha256) {
			const set = held.get(vaultId);
			if (!set) return;
			set.delete(sha256);
			if (set.size === 0) held.delete(vaultId);
		}
	};
}

/** The one shared instance for the batch import endpoint. */
export const inflightImportHashes: InflightHashes = createInflightHashes();
