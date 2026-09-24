import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABSOLUTE_SRC_RE, resolveRelativeLibraryPath } from './attachment-link';

test('resolveRelativeLibraryPath resolves a same-folder relative link', () => {
	assert.equal(resolveRelativeLibraryPath('math/notes.md', 'fig.png'), 'math/fig.png');
});

test('resolveRelativeLibraryPath resolves the exact shape importObsidian.ts writes (../_meta/attachments/x)', () => {
	// currentPath is one folder deep, attachment link climbs back up to _meta/
	assert.equal(
		resolveRelativeLibraryPath('math/notes.md', '../_meta/attachments/fig.png'),
		'_meta/attachments/fig.png'
	);
});

test('resolveRelativeLibraryPath resolves from a top-level file (no directory to climb)', () => {
	assert.equal(resolveRelativeLibraryPath('notes.md', '_meta/attachments/fig.png'), '_meta/attachments/fig.png');
});

test('resolveRelativeLibraryPath handles a deeply nested current file with multiple climbs', () => {
	assert.equal(
		resolveRelativeLibraryPath('a/b/c/notes.md', '../../../_meta/attachments/fig.png'),
		'_meta/attachments/fig.png'
	);
});

test('resolveRelativeLibraryPath ignores a redundant "./" prefix', () => {
	assert.equal(resolveRelativeLibraryPath('math/notes.md', './fig.png'), 'math/fig.png');
});

test('ABSOLUTE_SRC_RE matches http/https/data/blob URLs and root-relative paths', () => {
	for (const src of ['http://x.test/a.png', 'https://x.test/a.png', 'data:image/png;base64,abc', 'blob:xyz', '/abs/path.png', '//cdn.test/a.png']) {
		assert.equal(ABSOLUTE_SRC_RE.test(src), true, src);
	}
});

test('ABSOLUTE_SRC_RE does not match a plain relative attachment link', () => {
	for (const src of ['fig.png', '../_meta/attachments/fig.png', '_meta/attachments/fig.png']) {
		assert.equal(ABSOLUTE_SRC_RE.test(src), false, src);
	}
});
