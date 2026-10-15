import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkMarkdownFiles } from './walk-md';

test('notes are walked; _meta (revisions, staging) and other excluded dirs are not', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-md-'));
	try {
		const write = (rel: string) => {
			const abs = path.join(root, ...rel.split('/'));
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, '# x\n');
		};
		write('kuantum/note.md');
		write('top.md');
		write('_meta/revisions/kuantum/note.md/2026-10-10T07-32-16-076Z.md');
		write('_meta/staging/job/out.md');
		write('.obsidian/x.md');
		write('kuantum/notes.txt');
		const found = walkMarkdownFiles(root).map((p) => path.relative(root, p).split(path.sep).join('/')).sort();
		assert.deepEqual(found, ['kuantum/note.md', 'top.md']);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
