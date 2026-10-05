import { AppError } from '../app-error';
import { walkSource } from './common';
import { markdownFolderAdapter } from './markdown-folder';
import { logseqAdapter } from './logseq';
import { joplinExportAdapter } from './joplin-export';
import { isAdapterId, type AdapterId, type DetectResult, type SourceAdapter, type SourceTree } from './types';

/** Registry of the working adapters. Cards for apps that are not supported yet live in the UI only. */
export const ADAPTERS: Record<AdapterId, SourceAdapter> = {
	'markdown-folder': markdownFolderAdapter,
	logseq: logseqAdapter,
	'joplin-export': joplinExportAdapter
};

export function getAdapter(id: unknown): SourceAdapter {
	if (!isAdapterId(id)) throw new AppError('IMPORT_ADAPTER_UNKNOWN');
	return ADAPTERS[id];
}

export interface Detected extends DetectResult {
	adapter: AdapterId;
}

/**
 * Runs every adapter's detect() over ONE walk of the folder and returns them
 * ranked: matching adapters first, highest confidence first. The generic
 * markdown-folder adapter matches almost everything at low confidence, so a
 * Logseq graph or Joplin export outranks it, while an Obsidian vault (marker
 * folder, 0.9) outranks a plain folder.
 */
export async function detectAll(root: string, tree: SourceTree = walkSource(root)): Promise<Detected[]> {
	const results: Detected[] = [];
	for (const adapter of Object.values(ADAPTERS)) {
		results.push({ adapter: adapter.id, ...(await adapter.detect(root, tree)) });
	}
	return results.sort((a, b) => Number(b.match) - Number(a.match) || b.confidence - a.confidence);
}
