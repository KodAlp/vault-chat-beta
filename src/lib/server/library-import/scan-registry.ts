import crypto from 'node:crypto';
import type { AdapterId, ImportPlan } from './types';

/**
 * In-memory record of library-import scans, same idea as ../scan-registry.ts:
 * the run step names a scan by id and the server imports ONLY what that scan
 * recorded, under the root it validated — the client never sends a path or a
 * file list at import time. The plan holds link maps for a whole library, so
 * the cap is small and the TTL short; an unknown or expired id is simply
 * "not found" (the route turns that into SCAN_EXPIRED).
 */
export interface ImportScanRecord {
	vaultId: string;
	/** realpath of the scanned root. */
	root: string;
	adapter: AdapterId;
	plan: ImportPlan;
	createdAt: number;
}

export interface ImportScanRegistry {
	add(vaultId: string, root: string, adapter: AdapterId, plan: ImportPlan): string;
	get(scanId: unknown, vaultId: string): ImportScanRecord | undefined;
	size(): number;
}

export function createImportScanRegistry(
	opts: { ttlMs?: number; maxScans?: number; now?: () => number; newId?: () => string } = {}
): ImportScanRegistry {
	const ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
	const maxScans = opts.maxScans ?? 8;
	const now = opts.now ?? Date.now;
	const newId = opts.newId ?? (() => crypto.randomUUID());
	const scans = new Map<string, ImportScanRecord>();

	function prune(): void {
		const t = now();
		for (const [id, rec] of scans) if (t - rec.createdAt >= ttlMs) scans.delete(id);
	}

	return {
		add(vaultId, root, adapter, plan) {
			prune();
			// Map keeps insertion order: drop the oldest scans over the cap.
			while (scans.size >= maxScans) scans.delete(scans.keys().next().value as string);
			const id = newId();
			scans.set(id, { vaultId, root, adapter, plan, createdAt: now() });
			return id;
		},
		get(scanId, vaultId) {
			if (typeof scanId !== 'string') return undefined;
			prune();
			const rec = scans.get(scanId);
			return rec && rec.vaultId === vaultId ? rec : undefined;
		},
		size: () => scans.size
	};
}

/** The one shared instance for the library-import routes. */
export const importScanRegistry: ImportScanRegistry = createImportScanRegistry();
