import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	fixDuplicateTag,
	fixStrayDelimiters,
	fixGlyphJunk,
	fixHtmlEntities,
	fixMacroAliases,
	repairFormula,
	looksLikeCode,
	katexError,
	findMath,
	processText
} from './katex-cleanup.mjs';

test('fixDuplicateTag keeps the last (layout) tag', () => {
	assert.equal(fixDuplicateTag('a = b \\tag {1}\\tag{15.11}'), 'a = b \\tag{15.11}');
	assert.equal(fixDuplicateTag('a \\tag {9.}\\tag{9.56}'), 'a \\tag{9.56}');
	assert.equal(fixDuplicateTag('a \\tag{1}'), null);
	assert.equal(fixDuplicateTag('a = b'), null);
});

test('duplicate tag really fails KaTeX and the fix passes the gate', () => {
	const body = 'a = b \\tag {1}\\tag{15.11}';
	assert.ok(katexError(body));
	const r = repairFormula(body);
	assert.equal(r.status, 'fixed');
	assert.equal(r.body, 'a = b \\tag{15.11}');
	assert.deepEqual(r.applied, ['duplicate-tag']);
});

test('fixStrayDelimiters: stray \\] and broken \\tag{\\( ... \\}', () => {
	assert.equal(fixStrayDelimiters('x = 1 \\]'), 'x = 1 ');
	assert.equal(fixStrayDelimiters("x \\tag{\\( (Q') \\}"), "x \\tag{(Q')}");
	assert.equal(fixStrayDelimiters('\\[ x \\]'), null); // balanced: untouched
	assert.equal(fixStrayDelimiters('x = 1'), null);
});

test('stray \\] repaired through the gate', () => {
	const r = repairFormula('x = 1 \\]');
	assert.equal(r.status, 'fixed');
	assert.equal(katexError(r.body), null);
});

test('fixGlyphJunk only maps \\/', () => {
	assert.equal(fixGlyphJunk('a \\/ b'), 'a / b');
	assert.equal(fixGlyphJunk('\\Ss0'), null);
});

test('fixHtmlEntities decodes lt/gt but never &amp;', () => {
	assert.equal(fixHtmlEntities('a &lt; b &gt; c'), 'a < b > c');
	assert.equal(fixHtmlEntities('a &amp; b'), null);
});

test('fixMacroAliases', () => {
	assert.equal(fixMacroAliases('1,\\hdots,n'), '1,\\ldots,n');
	assert.equal(fixMacroAliases('a \\textless b'), 'a < b');
	assert.equal(fixMacroAliases('\\textmu A'), '\\mu A');
	assert.equal(fixMacroAliases('\\hdotsx'), null);
	assert.equal(fixMacroAliases('hdots'), null);
});

test('gate: a fix that does not make KaTeX accept is rejected (original kept)', () => {
	// duplicate tag removed, but \frac still broken -> unfixable, no body returned
	const r = repairFormula('\\frac{1 \\tag{1}\\tag{2}');
	assert.equal(r.status, 'unfixable');
	assert.equal(r.body, undefined);
});

test('valid formulas are untouched', () => {
	assert.equal(repairFormula('a \\tag{1}').status, 'ok');
	assert.equal(repairFormula('a \\/ b'.replace('\\/', '/')).status, 'ok');
});

test('code-like formulas are reported, never fixed', () => {
	const body = '\\text {addi $t0, $s0, 1} \\tag{1}\\tag{2}';
	assert.equal(looksLikeCode(body), true);
	assert.equal(repairFormula(body).status, 'code-like');
});

test('findMath: $$ block, inline, fenced code ignored', () => {
	const md = 'a $x$ b\n\n$$\ny = 1\n$$\n\n```\n$notmath$\n```\n';
	const m = findMath(md);
	assert.equal(m.length, 2);
	assert.equal(m[0].kind, 'inline');
	assert.equal(m[1].kind, 'display');
	assert.equal(md.slice(m[1].start, m[1].end), '$$\ny = 1\n$$');
});

test('processText rewrites only broken formulas and preserves everything else', () => {
	const md = '---\nconverter: mineru\n---\ntext\n\n$$\na \\tag {1}\\tag{2}\n$$\n\n$$\nb = 2\n$$\n';
	const r = processText(md);
	assert.equal(r.fixed.length, 1);
	assert.equal(r.text, '---\nconverter: mineru\n---\ntext\n\n$$\na \\tag{2}\n$$\n\n$$\nb = 2\n$$\n');
	assert.equal(r.fixed[0].line, 6);
});
