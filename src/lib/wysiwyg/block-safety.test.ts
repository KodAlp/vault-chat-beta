import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mathSpansAgree, isRoundTripSafe, planBySize, planByUnsafeCount, renderForCompare, MAX_VISUAL_BYTES, MAX_UNSAFE_BLOCKS } from './block-safety';

test('cosmetic serializer differences are safe (same viewer HTML)', () => {
	assert.ok(isRoundTripSafe('* a\n* b', '- a\n- b'));
	assert.ok(isRoundTripSafe('_em_ and __strong__', '*em* and **strong**'));
	assert.ok(isRoundTripSafe('| a | b |\n|---|---|\n| 1 | 2 |', '| a   | b   |\n| --- | --- |\n| 1   | 2   |'));
	assert.ok(isRoundTripSafe('see https://example.com', 'see <https://example.com>'));
	assert.ok(isRoundTripSafe('fish &amp; chips', 'fish & chips'));
	assert.ok(isRoundTripSafe('Setext\n=====', '# Setext'));
	assert.ok(isRoundTripSafe('## Heading ##', '## Heading'));
	assert.ok(isRoundTripSafe('[1] ref text', '\\[1] ref text'));
});

test('\\( \\) and \\[ \\] are math in the viewer, so $ forms are equivalent but plain parens are not', () => {
	assert.ok(isRoundTripSafe('a \\(x^2\\) b', 'a $x^2$ b'));
	assert.ok(isRoundTripSafe('\\[x = 1\\]', '$$x = 1$$'));
	assert.ok(!isRoundTripSafe('a \\(x^2\\) b', 'a (x^2) b'));
});

test('real changes are detected', () => {
	assert.ok(!isRoundTripSafe('**$x$**', '$x$'));
	assert.ok(!isRoundTripSafe('cost $5 and $6.', 'cost$5 and$6.'));
	assert.ok(!isRoundTripSafe('200. a\n201. b', '1. a\n2. b'));
	assert.ok(!isRoundTripSafe('line one\nline two', 'line one <br />\nline two'));
	assert.ok(!isRoundTripSafe('![alt](a.png)', '<br />'));
	assert.ok(!isRoundTripSafe('hello <sup>1</sup>', 'hello 1'));
});

test('KaTeX stub keeps the LaTeX source visible to the comparison', () => {
	assert.notEqual(renderForCompare('$a_1$'), renderForCompare('$a_2$'));
	assert.equal(renderForCompare('$$\nx\n$$'), renderForCompare('$$\nx\n$$'));
});

test('mode planning', () => {
	assert.deepEqual(planBySize(MAX_VISUAL_BYTES), { mode: 'visual' });
	assert.deepEqual(planBySize(MAX_VISUAL_BYTES + 1), { mode: 'source', reason: 'too-large' });
	assert.deepEqual(planByUnsafeCount(MAX_UNSAFE_BLOCKS), { mode: 'visual' });
	assert.deepEqual(planByUnsafeCount(MAX_UNSAFE_BLOCKS + 1), { mode: 'source', reason: 'too-many-unsafe' });
});

test('formula spans must be the same ones the viewer finds', () => {
	assert.ok(mathSpansAgree('a $x_1$ b $$y$$', ['x_1', 'y']));
	assert.ok(mathSpansAgree('plain text, no math', []));
	assert.ok(mathSpansAgree('euler \\(e^{i}\\)', ['e^{i}']));
	// remark-math would see one formula "5 and " here, markdown-it-katex sees none
	assert.ok(!mathSpansAgree('cost $5 and $6.', ['5 and ']));
	assert.ok(!mathSpansAgree('a $x$ b', []));
});
