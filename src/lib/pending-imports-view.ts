import type { PendingImportItem } from './types';

/** Items that still change by themselves (the converter is working) — the only reason to poll. */
export function hasActiveImports(items: readonly PendingImportItem[]): boolean {
	return items.some((i) => i.status === 'queued' || i.status === 'converting');
}

/** Items waiting for the user: a review (ready) or an acknowledgement (error). Drives the nav badge. */
export function attentionCount(items: readonly PendingImportItem[]): number {
	return items.filter((i) => i.status === 'ready' || i.status === 'error').length;
}
