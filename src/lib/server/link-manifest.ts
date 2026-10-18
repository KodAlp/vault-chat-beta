import fs from 'node:fs';
import path from 'node:path';
import type { VaultContext } from './vaults';
import { importLogPath } from './library';
import { loadImportedUrls } from './link-import';

export type ManifestStatus = 'pending' | 'failed' | 'skipped';

export interface ManifestEntry {
	batchId: string;
	url: string;
	status: ManifestStatus;
	code?: string;
	importId?: string;
	at: string;
}

const MAX_RETRYABLE = 200;

/** Lives next to import-log.jsonl so both share the vault's _meta folder. */
export function linkManifestPath(v: VaultContext): string {
	return path.join(path.dirname(importLogPath(v)), 'link-manifest.jsonl');
}

export function appendManifestEntry(manifestPath: string, entry: ManifestEntry): void {
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.appendFileSync(manifestPath, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * URLs whose latest manifest entry is 'failed' and that never made it into
 * the import log since — a later 'pending'/'skipped' entry or a confirmed
 * import means the URL no longer needs a retry. Newest first, capped.
 */
export function loadRetryableUrls(manifestPath: string, importLog: string): { url: string; code?: string; at: string }[] {
	if (!fs.existsSync(manifestPath)) return [];
	const latest = new Map<string, ManifestEntry>();
	for (const line of fs.readFileSync(manifestPath, 'utf-8').split('\n')) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as ManifestEntry;
			if (typeof e.url !== 'string' || typeof e.status !== 'string' || typeof e.at !== 'string') continue;
			latest.set(e.url, e);
		} catch {
			// malformed line — skip, don't let one bad entry break the scan
		}
	}
	const imported = loadImportedUrls(importLog);
	return [...latest.values()]
		.filter((e) => e.status === 'failed' && !imported.has(e.url))
		.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
		.slice(0, MAX_RETRYABLE)
		.map((e) => ({ url: e.url, code: e.code, at: e.at }));
}
