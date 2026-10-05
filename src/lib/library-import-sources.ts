/**
 * Client-safe description of the "Library import" sources (no fs, no server
 * imports — the server's adapter ids and the scan response shape live here so
 * both sides share ONE definition). The server only knows FORMATS (adapters);
 * the cards are apps: several apps map to the same adapter.
 */

export type AdapterId = 'markdown-folder' | 'logseq' | 'joplin-export';

export const ADAPTER_IDS: readonly AdapterId[] = ['markdown-folder', 'logseq', 'joplin-export'];

/** Response of POST /api/library/import-source/scan (the plan minus its internals). */
export interface LibraryImportScan {
	/** null when there is nothing to import: the preview then only explains why. */
	scanId: string | null;
	adapter: AdapterId;
	flavor?: string;
	/** Whether the chosen adapter recognized the folder (false = picked by hand). */
	matched: boolean;
	detected: { adapter: AdapterId; match: boolean; confidence: number; flavor?: string }[];
	notes: number;
	attachments: number;
	skipped: { rel: string; reason: string }[];
	skippedByReason: Record<string, number>;
	sampleTargets: string[];
	warnings: { code: string; count?: number }[];
}

export type SourceId = 'obsidian' | 'logseq' | 'joplin' | 'zettlr' | 'foamDendron' | 'markdown';

export interface ReadySource {
	id: SourceId;
	adapter: AdapterId;
	/** Brand name shown on the card. Obsidian-style names live in the catalog (LibraryImport.source_<id>). */
	initial: string;
	/** Example folder per OS, shown as the path placeholder. Literal paths: not translated. */
	examples: { win: string; mac: string; linux: string };
}

export const READY_SOURCES: readonly ReadySource[] = [
	{
		id: 'obsidian',
		adapter: 'markdown-folder',
		initial: 'Ob',
		examples: { win: 'C:\Users\you\Documents\MyVault', mac: '~/Documents/MyVault', linux: '~/Documents/MyVault' }
	},
	{
		id: 'logseq',
		adapter: 'logseq',
		initial: 'Lq',
		examples: { win: 'C:\Users\you\Documents\logseq', mac: '~/Documents/logseq', linux: '~/Documents/logseq' }
	},
	{
		id: 'joplin',
		adapter: 'joplin-export',
		initial: 'Jo',
		examples: { win: 'C:\Users\you\Documents\joplin-export', mac: '~/Documents/joplin-export', linux: '~/Documents/joplin-export' }
	},
	{
		id: 'zettlr',
		adapter: 'markdown-folder',
		initial: 'Ze',
		examples: { win: 'C:\Users\you\Documents\Zettlr', mac: '~/Documents/Zettlr', linux: '~/Documents/Zettlr' }
	},
	{
		id: 'foamDendron',
		adapter: 'markdown-folder',
		initial: 'Fd',
		examples: { win: 'C:\Users\you\Documents\notes', mac: '~/Documents/notes', linux: '~/Documents/notes' }
	},
	{
		id: 'markdown',
		adapter: 'markdown-folder',
		initial: 'Md',
		examples: { win: 'C:\Users\you\Documents\notes', mac: '~/Documents/notes', linux: '~/Documents/notes' }
	}
];

export interface SoonSource {
	id: string;
	/** Brand names are never translated. */
	name: string;
	initial: string;
}

/** Cards that are visible but not usable yet; each one's hint is LibraryImport.soon_<id>. */
export const SOON_SOURCES: readonly SoonSource[] = [
	{ id: 'notion', name: 'Notion', initial: 'No' },
	{ id: 'evernote', name: 'Evernote', initial: 'Ev' },
	{ id: 'bear', name: 'Bear', initial: 'Be' },
	{ id: 'notesnook', name: 'Notesnook', initial: 'Nk' },
	{ id: 'capacities', name: 'Capacities / Heptabase / Tana', initial: 'Ca' },
	{ id: 'siyuan', name: 'SiYuan', initial: 'Si' },
	{ id: 'trilium', name: 'Trilium Notes', initial: 'Tr' },
	{ id: 'anytype', name: 'Anytype', initial: 'An' },
	{ id: 'logseqDb', name: 'Logseq DB', initial: 'Ld' },
	{ id: 'affine', name: 'AFFiNE', initial: 'Af' },
	{ id: 'roam', name: 'Roam Research', initial: 'Ro' },
	{ id: 'keep', name: 'Google Keep', initial: 'Gk' },
	{ id: 'appleNotes', name: 'Apple Notes', initial: 'Ap' }
];
