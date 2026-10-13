import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixPropto, mapSymbolPua, SYMBOL_PUA, repairNote, countPua } from './symbol-propto-repair.mjs';

// Same cases as PROPTO_CASES in ingest/postprocess_test.py: change both together.
// [before, after]; after null = unchanged.
const PROPTO_CASES = [
	[String.raw`F \infty q_1 q_2 / r^2`, String.raw`F \propto q_1 q_2 / r^2`],
	[String.raw`\rho \, \infty \, a^{-3}`, String.raw`\rho \, \propto \, a^{-3}`],
	[String.raw`u_{\nu} \infty \nu^{3}`, String.raw`u_{\nu} \propto \nu^{3}`],
	[String.raw`f(x) \infty \frac{1}{x}`, String.raw`f(x) \propto \frac{1}{x}`],
	[String.raw`\left| x \right| \; \infty \; \sqrt{y}`, String.raw`\left| x \right| \; \propto \; \sqrt{y}`],
	[String.raw`\{ x \} \quad \infty \quad y`, String.raw`\{ x \} \quad \propto \quad y`],
	[String.raw`A [ b ] \infty 2`, String.raw`A [ b ] \propto 2`],
	[String.raw`\hbar \infty \omega`, String.raw`\hbar \propto \omega`],
	[String.raw`\lim_{x \to \infty} f(x) \infty y`, String.raw`\lim_{x \to \infty} f(x) \propto y`],
	[String.raw`\sum_{n=1}^{\infty} a_n`, null],
	[String.raw`\sum_{n=1}^\infty a_n`, null],
	[String.raw`\int_0^\infty f \, dx`, null],
	[String.raw`\int_{0}^{\infty} f \, dx`, null],
	[String.raw`a = \infty`, null],
	[String.raw`x \to \infty`, null],
	[String.raw`-\infty < x`, null],
	[String.raw`a \pm \infty b`, null],
	[String.raw`(a, \infty)`, null],
	[String.raw`[ a , \infty )`, null],
	[String.raw`\lim_{n \to \infty} a_n`, null],
	[String.raw`\mathcal{C} \infty \text{-category}`, null],
	[String.raw`\mathcal{C} \infty \text {-category}`, null],
	[String.raw`x ^ { a \infty b }`, null],
	[String.raw`\infty x`, null],
	[String.raw`x \infty`, null],
	[String.raw`x \infty = y`, null],
	[String.raw`x \infty ^ 2`, null],
	[String.raw`x \, \alpha \, y`, String.raw`x \, \propto \, y`],
	[String.raw`x \alpha \, y`, null],
	[String.raw`x \, \alpha y`, null],
	[String.raw`x \alpha y`, null],
	[String.raw`\alpha_{1} \, \alpha_{2}`, null]
];

test('fixPropto: same cases as the Python rule', () => {
	for (const [before, after] of PROPTO_CASES) {
		assert.equal(fixPropto(before), after ?? before, before);
	}
});

test('mapSymbolPua: codes, table coverage, code left verbatim', () => {
	assert.equal(mapSymbolPua('a  b'), 'a ∝ b');
	assert.equal(mapSymbolPua(''), '∞');
	assert.equal(mapSymbolPua(''), 'φ');
	assert.equal(mapSymbolPua(''), 'ϕ');
	assert.equal(mapSymbolPua(''), 'αβΓΩ');
	assert.equal(
		mapSymbolPua(''),
		'±×≤≥→⇔∇∫∑'
	);
	assert.equal(mapSymbolPua(''), '2+=−');
	assert.equal(mapSymbolPua(''), ''); // Apple logo: unmapped, stays
	for (let b = 0x20; b < 0xff; b++) {
		if (b === 0x7f || (b > 0x7f && b < 0xa0) || b === 0xf0) continue;
		assert.ok(SYMBOL_PUA.has(String.fromCharCode(0xf000 + b)), b.toString(16));
	}
	assert.equal(mapSymbolPua('$$x  y$$'), '$$x ∝ y$$');
	assert.equal(
		mapSymbolPua('```\nx = \n```\n\n`` and '),
		'```\nx = \n```\n\n`` and ∞'
	);
	assert.deepEqual(countPua(''), { mapped: 1, unmapped: 1 });
});

test('repairNote: frontmatter untouched, propto only in $$ outside code', () => {
	const src =
		'---\ntitle: a \\infty b\n---\n\ntext \\infty more \n\n$$F \\, \\infty \\, q$$\n\n```\n$$a \\infty b$$\n```\n\n$$\\sum_{n}^{\\infty} a$$\n';
	const r = repairNote(src);
	assert.equal(
		r.text,
		'---\ntitle: a \\infty b\n---\n\ntext \\infty more ∝\n\n$$F \\, \\propto \\, q$$\n\n```\n$$a \\infty b$$\n```\n\n$$\\sum_{n}^{\\infty} a$$\n'
	);
	assert.equal(r.propto.length, 1);
	assert.equal(r.propto[0].line, 7);
	assert.deepEqual(r.symbol, { mapped: 1, unmapped: 0 });
	assert.equal(repairNote(r.text).text, r.text); // idempotent
});
