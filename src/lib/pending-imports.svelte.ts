import type { PendingImportItem } from './types';
import { attentionCount } from './pending-imports-view';

/**
 * Shared state for the "pending imports" list of the active vault, so the panel on the upload page and
 * the badge in the settings nav stay in sync. Plain module-level $state; refresh() is the only writer.
 */
export const pendingImports = $state<{ items: PendingImportItem[]; vaultId: string | null; loaded: boolean }>({
	items: [],
	vaultId: null,
	loaded: false
});

export function pendingAttentionCount(): number {
	return attentionCount(pendingImports.items);
}

/** Returns false when the request failed (the previous list is kept). */
export async function refreshPendingImports(): Promise<boolean> {
	try {
		const res = await fetch('/api/library/pending-imports');
		if (!res.ok) return false;
		const data = (await res.json()) as { vault: string; imports: PendingImportItem[] };
		pendingImports.items = data.imports;
		pendingImports.vaultId = data.vault;
		pendingImports.loaded = true;
		return true;
	} catch {
		return false;
	}
}
