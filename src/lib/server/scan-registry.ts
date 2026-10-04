import crypto from 'node:crypto';

/**
 * In-memory record of folder scans (see folder-scan.ts), so a later per-file
 * import can name a file by { scanId, relPath } and the server resolves it
 * ONLY inside the root that was scanned, and only for paths the scan itself
 * listed. TTL and a hard cap bound memory; an unknown or expired id is simply
 * "not found" (the route turns that into a coded SCAN_EXPIRED error).
 */
export interface ScanRecord {
	vaultId: string;
	/** realpath of the scanned root. */
	root: string;
	/** relPaths the scan marked importable. */
	allowed: Set<string>;
	createdAt: number;
}

export interface ScanRegistry {
	add(vaultId: string, root: string, relPaths: Iterable<string>): string;
	get(scanId: unknown, vaultId: string): ScanRecord | undefined;
	size(): number;
}

export function createScanRegistry(
	opts: { ttlMs?: number; maxScans?: number; now?: () => number; newId?: () => string } = {}
): ScanRegistry {
	const ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
	const maxScans = opts.maxScans ?? 20;
	const now = opts.now ?? Date.now;
	const newId = opts.newId ?? (() => crypto.randomUUID());
	const scans = new Map<string, ScanRecord>();

	function prune(): void {
		const t = now();
		for (const [id, rec] of scans) if (t - rec.createdAt >= ttlMs) scans.delete(id);
	}

	return {
		add(vaultId, root, relPaths) {
			prune();
			// Map keeps insertion order: drop the oldest scans over the cap.
			while (scans.size >= maxScans) {
				const oldest = scans.keys().next().value as string;
				scans.delete(oldest);
			}
			const id = newId();
			scans.set(id, { vaultId, root, allowed: new Set(relPaths), createdAt: now() });
			return id;
		},
		get(scanId, vaultId) {
			if (typeof scanId !== 'string') return undefined;
			prune();
			const rec = scans.get(scanId);
			if (!rec || rec.vaultId !== vaultId) return undefined;
			return rec;
		},
		size: () => scans.size
	};
}

/** The one shared instance for the batch import routes. */
export const scanRegistry: ScanRegistry = createScanRegistry();
