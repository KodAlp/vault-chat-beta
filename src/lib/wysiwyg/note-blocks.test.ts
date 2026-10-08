import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitNote, assemble, alignBlocks, detectEol, toLf, type OutItem } from './note-blocks';

const keepAll = (m: ReturnType<typeof splitNote>): OutItem[] => m.parts.map((_, i) => ({ keep: i }));

// One fixture per hazard found when round-tripping the real library through an editor serializer.
const FIXTURES: Record<string, string> = {
	plain: '# Title\n\nA paragraph.\n\nAnother one.\n',
	'comment under image': '![alt](img/a.png)\n<!-- vc:gorsel abc123 -->\n\nSome text\n',
	'slide comment': '<!-- Slide number: 3 -->\n\n# Slide\n',
	'display math with blank line': 'Before\n\n$$\nx_1 +\n\n\\frac{a}{b}\n$$\n\nAfter\n',
	'inline math and currency': 'inline $a_i^2$ and cost $5 and $6.\n',
	'paren math': 'euler \\(e^{i\\pi}\\) and \\[x = 1\\]\n',
	table: '| a | b |\n|---|:-:|\n| 1 | 2 |\n| x_1 | y\\|z |\n',
	autolinks: 'see https://example.com and <https://x.org>\n',
	entities: 'fish &amp; chips &copy; 2020 &lt;b&gt;\n',
	'single tilde': 'tilde ~x~ and ~~del~~\n',
	setext: 'Setext\n======\n\nSub\n---\n',
	'closed atx': '## Heading ##\n\ntext\n',
	'indented code': 'para\n\n    indented code\n\nafter\n',
	'ordered numbering': '200. two hundred\n201. next\n\n1. one\n1. one again\n',
	'star bullets': '* a\n* b\n\n+ c\n',
	footnote: 'Text[^1]\n\n[^1]: the note\n',
	'raw html': '<div class="x">\nraw <b>html</b>\n</div>\n\ntext <sup>1</sup>\n',
	'hard breaks': 'line one  \nline two\\\nline three\n',
	fence: '```python\nprint("a_b")\n```\n\n~~~\ntilde fence\n~~~\n',
	'weird whitespace': '\n\n  \n# Lead\n\n\n\nGap\t\n\n\n',
	'no trailing newline': 'last line without newline',
	empty: '',
	'only blank': '\n\n',
	turkish: 'Türkçe şğıöüç İ ı, a < b > c, 3 * 4 * 5\n'
};

for (const [name, body] of Object.entries(FIXTURES)) {
	for (const [eolName, conv] of [
		['LF', (s: string) => s],
		['CRLF', (s: string) => s.replace(/\n/g, '\r\n')]
	] as const) {
		for (const fm of ['', '---\ntitle: x\ntags: [a]\n---\n']) {
			const raw = conv(fm + body);
			test(`zero-edit save is byte-identical: ${name} / ${eolName}${fm ? ' / frontmatter' : ''}`, () => {
				const m = splitNote(raw);
				assert.equal(assemble(m, keepAll(m)), raw);
				if (fm) assert.equal(m.frontmatter, conv(fm));
			});
		}
	}
}

test('mixed line endings stay byte-identical', () => {
	const raw = '# A\r\n\r\npara\n\nlast\r\n';
	const m = splitNote(raw);
	assert.equal(assemble(m, keepAll(m)), raw);
});

test('block count: a $$ block with blank lines is one block, a table is one block', () => {
	assert.equal(splitNote(FIXTURES['display math with blank line']).parts.length, 3);
	assert.equal(splitNote(FIXTURES.table).parts.length, 1);
});

test('detectEol picks the dominant style', () => {
	assert.equal(detectEol('a\r\nb\r\nc\n'), '\r\n');
	assert.equal(detectEol('a\nb\r\nc\n'), '\n');
	assert.equal(detectEol('single'), '\n');
	assert.equal(toLf('a\r\nb\rc\n'), 'a\nb\nc\n');
});

test('editing one block re-serializes only that block; every other byte is untouched', () => {
	const raw = '---\nk: v\n---\n# Title\r\n\r\nOne.\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n\r\nLast &amp; end.\r\n';
	const m = splitNote(raw);
	assert.equal(m.parts.length, 4);
	const items = keepAll(m);
	items[1] = { text: 'One, edited.', inheritGap: 1 };
	const out = assemble(m, items);
	assert.equal(out, raw.replace('One.', 'One, edited.'));
});

test('serialized text gets the note CRLF style; inserted blocks get a blank-line gap', () => {
	const raw = 'a\r\n\r\nb\r\n';
	const m = splitNote(raw);
	const out = assemble(m, [{ keep: 0 }, { text: 'new\nmulti' }, { keep: 1 }]);
	assert.equal(out, 'a\r\n\r\nnew\r\nmulti\r\n\r\nb\r\n');
});

test('deleting a block drops only that block', () => {
	const raw = 'a\n\nb\n\nc\n';
	const m = splitNote(raw);
	assert.equal(assemble(m, [{ keep: 0 }, { keep: 2 }]), 'a\n\nc\n');
});

test('alignBlocks: untouched, edited, inserted and deleted blocks', () => {
	const orig = ['a', 'b', 'c', 'd'];
	assert.deepEqual(alignBlocks(orig, orig).map((x) => x.kind), ['same', 'same', 'same', 'same']);
	assert.deepEqual(alignBlocks(orig, ['a', 'B', 'c', 'd']), [
		{ kind: 'same', orig: 0 },
		{ kind: 'edited', orig: 1 },
		{ kind: 'same', orig: 2 },
		{ kind: 'same', orig: 3 }
	]);
	assert.deepEqual(alignBlocks(orig, ['a', 'b', 'x', 'c', 'd']).map((x) => x.kind), ['same', 'same', 'new', 'same', 'same']);
	assert.deepEqual(alignBlocks(orig, ['a', 'd']).map((x) => x.orig), [0, 3]);
	assert.deepEqual(alignBlocks([], ['x', 'y']).map((x) => x.kind), ['new', 'new']);
	assert.deepEqual(alignBlocks(orig, []), []);
});

test('alignBlocks handles an edit in the middle of a long note without confusing repeated blocks', () => {
	const orig = Array.from({ length: 2000 }, (_, i) => `p${i % 7}`);
	const cur = [...orig];
	cur[1000] = 'EDIT';
	const al = alignBlocks(orig, cur);
	assert.equal(al.filter((x) => x.kind === 'same').length, 1999);
	assert.deepEqual(al[1000], { kind: 'edited', orig: 1000 });
});
