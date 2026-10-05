import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	readDirectory,
	readDroppedRoots,
	routeFor,
	seedsFromSelection,
	selectionFromDropped,
	selectionFromFileList,
	splitFolderPath,
	type EntryLike
} from './import-selection';

type F = { name: string; size: number; webkitRelativePath?: string };
const f = (name: string, size = 10, webkitRelativePath?: string): F => ({ name, size, webkitRelativePath });

test('routeFor: one loose file is the single flow', () => {
	assert.equal(routeFor(selectionFromFileList([f('a.pdf')], false)), 'single');
});

test('routeFor: several files or any folder is the batch flow, nothing is none', () => {
	assert.equal(routeFor(selectionFromFileList([f('a.pdf'), f('b.pdf')], false)), 'batch');
	assert.equal(routeFor(selectionFromFileList([f('a.pdf', 1, 'Dir/a.pdf')], true)), 'batch');
	assert.equal(routeFor(selectionFromFileList([], false)), 'none');
	assert.equal(routeFor({ kind: 'scan', scanId: 's', folderName: 'x', entries: [{ relPath: 'a.pdf', size: 1 }] }), 'batch');
	assert.equal(routeFor({ kind: 'scan', scanId: 's', folderName: 'x', entries: [] }), 'none');
});

test('splitFolderPath strips the root and the filename', () => {
	assert.deepEqual(splitFolderPath('Root/a/b/x.pdf', 'x.pdf'), { folder: 'Root', relDir: 'a/b', inner: 'a/b/x.pdf' });
	assert.deepEqual(splitFolderPath('Root/x.pdf', 'x.pdf'), { folder: 'Root', relDir: '', inner: 'x.pdf' });
	assert.deepEqual(splitFolderPath('', 'x.pdf'), { folder: '', relDir: '', inner: 'x.pdf' });
});

test('selectionFromFileList: folder pick takes its name and relDirs from webkitRelativePath', () => {
	const sel = selectionFromFileList([f('x.pdf', 1, 'Course/week1/x.pdf'), f('y.md', 1, 'Course/y.md')], true);
	assert.equal(sel.kind, 'items');
	if (sel.kind !== 'items') return;
	assert.equal(sel.folderName, 'Course');
	assert.deepEqual(sel.items.map((i) => i.relDir), ['week1', '']);
});

test('selectionFromDropped: a lone folder behaves like picking it', () => {
	const sel = selectionFromDropped<F>([
		{ kind: 'dir', name: 'Course', files: [{ file: f('x.pdf'), path: 'w1/x.pdf' }, { file: f('y.md'), path: 'y.md' }] }
	]);
	assert.equal(sel.kind === 'items' && sel.folderName, 'Course');
	assert.deepEqual(sel.kind === 'items' && sel.items.map((i) => [i.relDir, i.inner]), [['w1', 'w1/x.pdf'], ['', 'y.md']]);
	assert.equal(routeFor(sel), 'batch');
});

test('selectionFromDropped: mixed drop keeps each folder name as a relDir segment, no domain', () => {
	const sel = selectionFromDropped<F>([
		{ kind: 'file', file: f('loose.pdf') },
		{ kind: 'dir', name: 'A', files: [{ file: f('x.pdf'), path: 'x.pdf' }, { file: f('z.pdf'), path: 'sub/z.pdf' }] }
	]);
	assert.equal(sel.kind === 'items' && sel.folderName, '');
	assert.deepEqual(sel.kind === 'items' && sel.items.map((i) => i.relDir), ['', 'A', 'A/sub']);
	assert.equal(routeFor(sel), 'batch');
});

test('selectionFromDropped: one dropped file is the single flow', () => {
	assert.equal(routeFor(selectionFromDropped<F>([{ kind: 'file', file: f('a.pdf') }])), 'single');
});

test('seedsFromSelection applies the shared filter and maps scans', () => {
	const sel = selectionFromFileList([f('ok.pdf', 1, 'R/ok.pdf'), f('x.exe', 1, 'R/x.exe'), f('a.pdf', 1, 'R/.git/a.pdf')], true);
	assert.deepEqual(seedsFromSelection(sel).map((s) => s.skip), [null, 'unsupported', 'junk']);
	const scanSeeds = seedsFromSelection<F>({
		kind: 'scan',
		scanId: 's1',
		folderName: 'R',
		entries: [{ relPath: 'a/b.pdf', size: 3 }, { relPath: 'c.bin', size: 1, skip: 'unsupported' }]
	});
	assert.deepEqual(scanSeeds.map((s) => [s.name, s.relDir, s.skip, s.scan?.relPath]), [
		['b.pdf', 'a', null, 'a/b.pdf'],
		['c.bin', '', 'unsupported', 'c.bin']
	]);
});

/* ---- fake FileSystemEntry tree ---- */
type Node = { name: string; children?: Node[] };
function entry(node: Node, batch = 2): EntryLike<F> {
	if (!node.children) return { isFile: true, isDirectory: false, name: node.name, file: (ok) => ok(f(node.name)) };
	return {
		isFile: false,
		isDirectory: true,
		name: node.name,
		createReader: () => {
			let i = 0;
			return {
				// Hands back `batch` entries at a time and [] at the end, like Chromium.
				readEntries: (ok) => {
					const slice = node.children!.slice(i, i + batch).map((c) => entry(c, batch));
					i += batch;
					ok(slice);
				}
			};
		}
	};
}

test('readDirectory walks nested folders across several readEntries batches', async () => {
	const tree: Node = {
		name: 'Root',
		children: [
			{ name: 'a.pdf' },
			{ name: 'b.pdf' },
			{ name: 'c.pdf' },
			{ name: 'sub', children: [{ name: 'd.md' }, { name: 'deep', children: [{ name: 'e.md' }] }] }
		]
	};
	const got = await readDirectory(entry(tree));
	assert.deepEqual(got.map((g) => g.path).sort(), ['a.pdf', 'b.pdf', 'c.pdf', 'sub/d.md', 'sub/deep/e.md']);
});

test('readDirectory does not descend into hidden/junk folders', async () => {
	const tree: Node = {
		name: 'Root',
		children: [{ name: '.git', children: [{ name: 'x' }] }, { name: '__MACOSX', children: [{ name: 'y' }] }, { name: 'ok.md' }]
	};
	assert.deepEqual((await readDirectory(entry(tree))).map((g) => g.path), ['ok.md']);
});

test('readDirectory stops at the entry budget', async () => {
	const tree: Node = { name: 'Root', children: Array.from({ length: 10 }, (_, i) => ({ name: 'f' + i + '.md' })) };
	assert.equal((await readDirectory(entry(tree), { left: 3 })).length, 3);
});

test('readDroppedRoots takes every entry before awaiting and falls back to getAsFile', async () => {
	const order: string[] = [];
	const mk = (name: string, node?: Node) => ({
		kind: 'file',
		webkitGetAsEntry: () => {
			order.push('take:' + name);
			return node ? entry(node) : null;
		},
		getAsFile: () => f(name)
	});
	const roots = await readDroppedRoots<F>([
		mk('Dir', { name: 'Dir', children: [{ name: 'a.md' }] }),
		mk('loose.pdf'),
		{ kind: 'string' }
	]);
	assert.deepEqual(order, ['take:Dir', 'take:loose.pdf']);
	assert.deepEqual(roots.map((r) => r.kind), ['dir', 'file']);
});
