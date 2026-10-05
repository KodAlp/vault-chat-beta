import { MAX_SCAN_DEPTH, MAX_SCAN_ENTRIES, isJunkName, skipReasonFor, type SkipReason } from './import-filter';

/**
 * What the user handed the "Add files" dialog, independent of HOW they handed it
 * (file input, folder input, dropped files/folders, the Linux desktop's native
 * folder scan). Pure and isomorphic on purpose — no DOM globals, no $lib alias
 * (the test runner cannot resolve it) — so the routing rule and the dropped-folder
 * walk are unit-tested without a browser; the DOM types are described structurally.
 */

/** A file the user picked, with where it sits relative to the picked folder.
 * `relDir` is exactly what POST /api/import/batch expects (the picked root's own
 * name and the filename both stripped; batch-paths.ts sanitizes it further),
 * `inner` is the path the shared import filter judges. */
export interface PickedItem<F> {
	file: F;
	relDir: string;
	inner: string;
}

export interface ScanEntry {
	relPath: string;
	size: number;
	skip?: SkipReason;
}

export type Selection<F> =
	| { kind: 'items'; items: PickedItem<F>[]; folderName: string; fromFolder: boolean }
	/** Linux desktop: the server walked the folder (POST /api/import/batch/scan). */
	| { kind: 'scan'; scanId: string; folderName: string; entries: ScanEntry[] };

export type ImportRoute = 'none' | 'single' | 'batch';

/**
 * THE routing rule: exactly one loose file → the single-file flow (convert, then a
 * review step for title/domain/level); anything else — several files, or any folder
 * (even one holding a single file, because a folder's name is the domain) — → the
 * batch flow, which imports directly with defaults.
 */
export function routeFor<F>(sel: Selection<F>): ImportRoute {
	if (sel.kind === 'scan') return sel.entries.length === 0 ? 'none' : 'batch';
	if (sel.items.length === 0) return 'none';
	return sel.items.length === 1 && !sel.fromFolder ? 'single' : 'batch';
}

/** "Picked/sub/dir/x.pdf" (a folder input's webkitRelativePath) → its parts. */
export function splitFolderPath(relativePath: string, fileName: string): { folder: string; relDir: string; inner: string } {
	const parts = relativePath.split('/').filter(Boolean);
	return {
		folder: parts.length > 1 ? parts[0] : '',
		relDir: parts.length > 2 ? parts.slice(1, -1).join('/') : '',
		inner: parts.length > 1 ? parts.slice(1).join('/') : fileName
	};
}

type FileWithPath = { name: string; size: number; webkitRelativePath?: string };

/** One <input type=file> pick: a folder pick's files carry webkitRelativePath, a plain pick's carry none. */
export function selectionFromFileList<F extends FileWithPath>(files: F[], isFolder: boolean): Selection<F> {
	const items: PickedItem<F>[] = [];
	let folderName = '';
	for (const file of files) {
		const { folder, relDir, inner } = isFolder
			? splitFolderPath(file.webkitRelativePath ?? '', file.name)
			: { folder: '', relDir: '', inner: file.name };
		if (!folderName) folderName = folder;
		items.push({ file, relDir, inner });
	}
	return { kind: 'items', items, folderName, fromFolder: isFolder };
}

/** A top-level thing from a drop: a loose file, or a folder with every file under it ("sub/x.pdf", relative to it). */
export type DroppedRoot<F> = { kind: 'file'; file: F } | { kind: 'dir'; name: string; files: { file: F; path: string }[] };

/**
 * Drop → selection. One folder and nothing else behaves exactly like picking that
 * folder (its name becomes the domain, relDir is the path below it). Mixed drops or
 * several folders have no single domain name, so each folder's own name is kept as the
 * first relDir segment instead — nothing is silently merged — and folderName stays ''.
 */
export function selectionFromDropped<F extends { name: string }>(roots: DroppedRoot<F>[]): Selection<F> {
	const dirs = roots.filter((r): r is Extract<DroppedRoot<F>, { kind: 'dir' }> => r.kind === 'dir');
	const single = dirs.length === 1 && roots.length === 1;
	const items: PickedItem<F>[] = [];
	for (const root of roots) {
		if (root.kind === 'file') {
			items.push({ file: root.file, relDir: '', inner: root.file.name });
			continue;
		}
		for (const { file, path } of root.files) {
			const segs = path.split('/').filter(Boolean);
			const below = segs.slice(0, -1).join('/');
			if (single) items.push({ file, relDir: below, inner: path });
			else items.push({ file, relDir: [root.name, below].filter(Boolean).join('/'), inner: root.name + '/' + path });
		}
	}
	return { kind: 'items', items, folderName: single ? dirs[0].name : '', fromFolder: dirs.length > 0 };
}

/** What the queue builders need from either source. */
export interface QueueSeed<F> {
	name: string;
	size: number;
	relDir: string;
	file?: F;
	scan?: { scanId: string; relPath: string };
	/** Why the shared filter skips it, or null to import it. */
	skip: SkipReason | null;
}

export function seedsFromSelection<F extends { name: string; size: number }>(sel: Selection<F>): QueueSeed<F>[] {
	if (sel.kind === 'scan') {
		return sel.entries.map((e) => {
			const parts = e.relPath.split('/');
			const name = parts.pop() ?? e.relPath;
			return {
				name,
				size: e.size,
				relDir: parts.join('/'),
				scan: { scanId: sel.scanId, relPath: e.relPath },
				// The server already ran the same filter (folder-scan.ts).
				skip: e.skip ?? null
			};
		});
	}
	return sel.items.map(({ file, relDir, inner }) => ({
		name: file.name,
		size: file.size,
		relDir,
		file,
		skip: skipReasonFor(inner, file.size)
	}));
}

/* ---- Reading a dropped folder (File System Access "entries" API) ---- */

/** Structural FileSystemEntry: `F` is the File type, kept generic so tests need no DOM. */
export interface EntryLike<F> {
	isFile: boolean;
	isDirectory: boolean;
	name: string;
	file?: (ok: (file: F) => void, fail?: (err: unknown) => void) => void;
	createReader?: () => { readEntries(ok: (entries: EntryLike<F>[]) => void, fail?: (err: unknown) => void): void };
}

/** Structural DataTransferItem. */
export interface DropItemLike<F> {
	kind: string;
	webkitGetAsEntry?: () => EntryLike<F> | null;
	getAsFile?: () => F | null;
}

/** Same ceiling the server-side scan applies, so a dropped mega-tree cannot freeze the tab. */
export const MAX_DROP_ENTRIES = MAX_SCAN_ENTRIES;

async function readAllEntries<F>(entry: EntryLike<F>): Promise<EntryLike<F>[]> {
	const reader = entry.createReader?.();
	if (!reader) return [];
	const all: EntryLike<F>[] = [];
	// readEntries hands back at most ~100 entries per call (Chromium) and an empty batch at the end.
	for (;;) {
		const batch = await new Promise<EntryLike<F>[]>((resolve, reject) => reader.readEntries(resolve, reject));
		if (batch.length === 0) return all;
		all.push(...batch);
	}
}

function fileOf<F>(entry: EntryLike<F>): Promise<F> {
	return new Promise((resolve, reject) => {
		if (!entry.file) reject(new Error('not a file entry'));
		else entry.file(resolve, reject);
	});
}

/** Depth-first walk of one dropped folder → { file, path-below-the-folder }. Junk folders (.git, other hidden
 * trees, __MACOSX) are not descended into at all, not read and then filtered — a dropped repository would
 * otherwise cost tens of thousands of async reads for files the filter rejects anyway. */
export async function readDirectory<F>(
	dir: EntryLike<F>,
	budget: { left: number } = { left: MAX_DROP_ENTRIES }
): Promise<{ file: F; path: string }[]> {
	const out: { file: F; path: string }[] = [];
	const walk = async (entry: EntryLike<F>, prefix: string, depth: number): Promise<void> => {
		for (const child of await readAllEntries(entry)) {
			if (budget.left <= 0) return;
			if (child.isDirectory) {
				if (depth >= MAX_SCAN_DEPTH || isJunkName(child.name)) continue;
				await walk(child, prefix + child.name + '/', depth + 1);
			} else if (child.isFile) {
				budget.left -= 1;
				out.push({ file: await fileOf(child), path: prefix + child.name });
			}
		}
	};
	await walk(dir, '', 0);
	return out;
}

/**
 * DataTransfer items → roots. The entries MUST all be taken synchronously: the browser
 * invalidates DataTransferItems once the drop handler yields, which is why the first loop
 * runs before any await. (No `webkitGetAsEntry` — an old WebView — degrades to loose files.)
 */
export async function readDroppedRoots<F>(items: ArrayLike<DropItemLike<F>>): Promise<DroppedRoot<F>[]> {
	const taken: { entry?: EntryLike<F>; file?: F }[] = [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item.kind !== 'file') continue;
		const entry = item.webkitGetAsEntry?.() ?? null;
		if (entry) taken.push({ entry });
		else {
			const file = item.getAsFile?.() ?? null;
			if (file) taken.push({ file });
		}
	}
	const budget = { left: MAX_DROP_ENTRIES };
	const roots: DroppedRoot<F>[] = [];
	for (const t of taken) {
		if (t.file) roots.push({ kind: 'file', file: t.file });
		else if (t.entry?.isDirectory) roots.push({ kind: 'dir', name: t.entry.name, files: await readDirectory(t.entry, budget) });
		else if (t.entry?.isFile) roots.push({ kind: 'file', file: await fileOf(t.entry) });
	}
	return roots;
}
