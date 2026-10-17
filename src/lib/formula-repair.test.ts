import test from 'node:test';
import assert from 'node:assert/strict';
import { findUnreadableFormulas, replaceUnreadableFormula } from './formula-repair';

const SHA = '7dd72a0ef1d7f7eb';
const BLOCK = [
	`![Okunamayan formül — s. 87](../_meta/attachments/${SHA}.png)`,
	`<!-- vc:formul-gorsel ${SHA} s.87 -->`,
	'',
	'> ⚠ Formül okunamadı — s. 87',
	'',
	'<!-- vc:formul-latex eF4y -->'
].join('\n');

test('finds a full block with its previous latex', () => {
	const md = `Intro\n\n${BLOCK}\n\nOutro\n`;
	const [b] = findUnreadableFormulas(md);
	assert.equal(b.sha, SHA);
	assert.equal(b.page, 87);
	assert.equal(b.bbox, null);
	assert.equal(b.previousB64, 'eF4y');
	assert.equal(md.slice(b.start, b.end), BLOCK);
});

test('latex comment and blank lines are optional; new k= suffix is parsed', () => {
	const md = `![x](images/${SHA}.png)\n<!-- vc:formul-gorsel ${SHA} s.3 k=72,100.5,300,-4 -->\n> ⚠ Formül okunamadı — s. 3\nrest`;
	const [b] = findUnreadableFormulas(md);
	assert.deepEqual(b.bbox, [72, 100.5, 300, -4]);
	assert.equal(b.previousB64, null);
	assert.equal(md.slice(b.start, b.end), md.split('\nrest')[0]);
});

test('CRLF text is tolerated and replacement keeps CRLF', () => {
	const md = `a\r\n\r\n${BLOCK.replace(/\n/g, '\r\n')}\r\n\r\nz\r\n`;
	assert.equal(findUnreadableFormulas(md).length, 1);
	const out = replaceUnreadableFormula(md, SHA, 'x^2\n+1');
	assert.equal(out, 'a\r\n\r\n$$\r\nx^2\r\n+1\r\n$$\r\n\r\nz\r\n');
});

test('replaces only the chosen block', () => {
	const other = BLOCK.replaceAll(SHA, '0123456789abcdef').replace('s.87', 's.9');
	const md = `${BLOCK}\n\ntext\n\n${other}\n`;
	assert.equal(findUnreadableFormulas(md).length, 2);
	const out = replaceUnreadableFormula(md, SHA, 'E=mc^2')!;
	assert.equal(out, `$$\nE=mc^2\n$$\n\ntext\n\n${other}\n`);
});

test('unknown sha, empty latex and a stray $$ yield null', () => {
	assert.equal(replaceUnreadableFormula(BLOCK, 'ffffffffffffffff', 'x'), null);
	assert.equal(replaceUnreadableFormula(BLOCK, SHA, '  '), null);
	assert.equal(replaceUnreadableFormula(BLOCK, SHA, 'a $$ b'), null);
});

test('a block shown inside a code fence is ignored', () => {
	assert.equal(findUnreadableFormulas('```\n' + BLOCK + '\n```\n').length, 0);
});

test('a marker without an image line still forms a block', () => {
	const md = `<!-- vc:formul-gorsel ${SHA} s.1 -->\n\n> ⚠ Formül okunamadı — s. 1`;
	const out = replaceUnreadableFormula(md, SHA, 'y');
	assert.equal(out, '$$\ny\n$$');
});
