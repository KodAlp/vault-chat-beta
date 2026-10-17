import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFixes } from './katex-manual-fix.mjs';

const FM = '---\nconverter: mineru\n---\n';

test('to: replaces the whole formula including delimiters', () => {
	const src = FM + 'a $x \\neqq 1$ b\n';
	const r = applyFixes(src, [{ line: 4, body: 'x \\neqq 1', to: '$x \\not\\equiv 1$' }]);
	assert.equal(r.text, FM + 'a $x \\not\\equiv 1$ b\n');
	assert.equal(r.applied.length, 1);
});

test('to: a display formula can become a code fence', () => {
	const src = FM + 'text\n\n$$\n\\text {lw} \\quad \\text {t0 # x}\n$$\n\nmore\n';
	const r = applyFixes(src, [{ line: 6, body: '\n\\text {lw} \\quad \\text {t0 # x}\n', to: '```asm\nlw $t0  # x\n```' }]);
	assert.equal(r.text, FM + 'text\n\n```asm\nlw $t0  # x\n```\n\nmore\n');
});

test('bodyEdits keep the delimiters and edit inside the body', () => {
	const src = FM + '$$\n\\text {(by Lemma \\ref{a})}\n$$\n';
	const r = applyFixes(src, [{ line: 4, body: '\n\\text {(by Lemma \\ref{a})}\n', bodyEdits: [['\\ref{a}', '??']] }]);
	assert.equal(r.text, FM + '$$\n\\text {(by Lemma ??)}\n$$\n');
});

test('find/replace reaches outside the formula on its line', () => {
	const src = FM + "vectors $Y _ { S } ' _ { s }$ such that\n";
	const r = applyFixes(src, [{ line: 4, body: "Y _ { S } ' _ { s }", find: "$Y _ { S } ' _ { s }$ such", replace: '$Y_{S}$’s such' }]);
	assert.equal(r.text, FM + 'vectors $Y_{S}$’s such that\n');
});

test('all: every identical formula on the line', () => {
	const src = FM + '| A $D^{2}^{x}$ | B $D^{2}^{x}$ |\n';
	const r = applyFixes(src, [{ line: 4, body: 'D^{2}^{x}', to: 'D2$^{x}$', all: true }]);
	assert.equal(r.text, FM + '| A D2$^{x}$ | B D2$^{x}$ |\n');
});

test('skips: formula not found, ambiguous find, replacement still invalid', () => {
	const src = FM + 'a $x \\neqq 1$ and $x \\neqq 1$\n';
	const r = applyFixes(src, [
		{ line: 9, body: 'nope', to: '$y$' },
		{ line: 4, body: 'x \\neqq 1', to: '$x$' },
		{ line: 4, body: 'x \\neqq 1', find: '$x \\neqq 1$', replace: '$x$' }
	]);
	assert.equal(r.text, src);
	assert.equal(r.skipped.length, 3);
	const bad = applyFixes(FM + 'a $\\neqq$\n', [{ line: 4, body: '\\neqq', to: '$\\frac{1}$' }]);
	assert.equal(bad.applied.length, 0);
	assert.match(bad.skipped[0].reason, /KaTeX/);
});

test('CRLF files keep CRLF in replacements', () => {
	const src = FM.replace(/\n/g, '\r\n') + '$$\r\n\\text {a}\r\n$$\r\n';
	const r = applyFixes(src, [{ line: 4, body: '\r\n\\text {a}\r\n', to: '```c\nint a;\n```' }]);
	assert.ok(r.text.endsWith('```c\r\nint a;\r\n```\r\n'));
});
