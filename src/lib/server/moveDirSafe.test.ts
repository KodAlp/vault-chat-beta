import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cpSync } from 'node:fs';
import { diffTrees, listTree, moveDirSafe, robocopyFailed } from './moveDirSafe';

function fixture(): { root: string; src: string; dest: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'movedir-'));
	const src = path.join(root, 'src');
	fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
	fs.writeFileSync(path.join(src, 'a.md'), 'alpha');
	fs.writeFileSync(path.join(src, 'sub', 'b.md'), 'bravo!');
	return { root, src, dest: path.join(root, 'dest', 'library') };
}

const exdev = (): never => {
	throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
};
const realCopy = (s: string, d: string): void => cpSync(s, d, { recursive: true, errorOnExist: true, force: false });

test('EXDEV rename -> copy path used, source deleted only after the copy verified', () => {
	const { root, src, dest } = fixture();
	try {
		const order: string[] = [];
		moveDirSafe(src, dest, {
			rename: exdev,
			copy: (s, d) => {
				order.push('copy');
				realCopy(s, d);
			},
			remove: (p) => {
				order.push('remove');
				assert.ok(fs.existsSync(path.join(dest, 'sub', 'b.md')), 'copy complete before source removal');
				fs.rmSync(p, { recursive: true, force: true });
			}
		});
		assert.deepEqual(order, ['copy', 'remove']);
		assert.equal(fs.existsSync(src), false);
		assert.equal(fs.readFileSync(path.join(dest, 'sub', 'b.md'), 'utf-8'), 'bravo!');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a copier that copies nothing leaves the source intact and throws a coded error', () => {
	const { root, src, dest } = fixture();
	try {
		assert.throws(
			() => moveDirSafe(src, dest, { rename: exdev, copy: () => {} }),
			(e: { code?: string }) => e.code === 'MIGRATE_COPY_VERIFY_FAILED'
		);
		assert.ok(fs.existsSync(path.join(src, 'a.md')));
		assert.ok(fs.existsSync(path.join(src, 'sub', 'b.md')));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a copier that throws leaves the source intact and throws MIGRATE_COPY_FAILED', () => {
	const { root, src, dest } = fixture();
	try {
		assert.throws(
			() =>
				moveDirSafe(src, dest, {
					rename: exdev,
					copy: () => {
						throw new Error('spawn robocopy ENOENT');
					}
				}),
			(e: { code?: string }) => e.code === 'MIGRATE_COPY_FAILED'
		);
		assert.ok(fs.existsSync(path.join(src, 'a.md')));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a partial copy (size mismatch) is rejected and the source survives', () => {
	const { root, src, dest } = fixture();
	try {
		assert.throws(
			() =>
				moveDirSafe(src, dest, {
					rename: exdev,
					copy: (_s, d) => {
						fs.writeFileSync(path.join(d, 'a.md'), 'alp'); // truncated
						fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
						fs.writeFileSync(path.join(d, 'sub', 'b.md'), 'bravo!');
					}
				}),
			(e: { code?: string }) => e.code === 'MIGRATE_COPY_VERIFY_FAILED'
		);
		assert.equal(fs.readFileSync(path.join(src, 'a.md'), 'utf-8'), 'alpha');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('successful rename never touches copy/remove; missing source just creates dest', () => {
	const { root, src, dest } = fixture();
	try {
		let touched = false;
		moveDirSafe(src, dest, {
			rename: () => {},
			copy: () => (touched = true) as unknown as void,
			remove: () => (touched = true) as unknown as void
		});
		assert.equal(touched, false);
		const empty = path.join(root, 'new', 'lib');
		moveDirSafe(path.join(root, 'nope'), empty);
		assert.ok(fs.existsSync(empty));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('real cpSync default path (non-win32) copies and verifies end to end', { skip: process.platform === 'win32' ? 'default copier is robocopy on win32' : false }, () => {
	const { root, src, dest } = fixture();
	try {
		moveDirSafe(src, dest, { rename: exdev });
		assert.equal(fs.existsSync(src), false);
		assert.deepEqual([...listTree(dest).keys()].sort(), ['a.md', 'sub/b.md']);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('robocopyFailed: null status (spawn failure) and >=8 fail, 0-7 succeed', () => {
	assert.equal(robocopyFailed(null), true);
	assert.equal(robocopyFailed(0), false);
	assert.equal(robocopyFailed(3), false);
	assert.equal(robocopyFailed(7), false);
	assert.equal(robocopyFailed(8), true);
	assert.equal(robocopyFailed(0, new Error('ENOENT')), true);
});

test('diffTrees reports missing, extra and resized files', () => {
	const a = new Map([['x', 1], ['y', 2]]);
	assert.deepEqual(diffTrees(a, new Map(a)), []);
	assert.equal(diffTrees(a, new Map([['x', 1]])).length, 1);
	assert.equal(diffTrees(a, new Map([['x', 1], ['y', 3]])).length, 1);
	assert.equal(diffTrees(a, new Map([['x', 1], ['y', 2], ['z', 0]])).length, 1);
});
