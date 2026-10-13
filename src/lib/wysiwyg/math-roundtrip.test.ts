import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkMath from 'remark-math';

// The editor's math plugin (milkdown-math.ts) maps mdast `inlineMath` / `math` nodes to
// math_inline / math_block and back, so markdown fidelity is decided by this remark layer.
const proc = unified().use(remarkParse).use(remarkMath).use(remarkStringify);
const roundTrip = (md: string) => String(proc.processSync(md));

const types = (md: string) => {
	const out: string[] = [];
	const walk = (n: { type: string; children?: unknown[] }) => {
		out.push(n.type);
		for (const c of (n.children ?? []) as { type: string; children?: unknown[] }[]) walk(c);
	};
	walk(proc.parse(md) as never);
	return out;
};

test('inline $...$ parses as inlineMath and survives a round trip', () => {
	const md = 'euler $e^{i\\pi} + 1 = 0$ and $a_i^2$.\n';
	assert.ok(types(md).includes('inlineMath'));
	assert.equal(roundTrip(md), md);
});

test('block $$...$$ parses as math and survives a round trip', () => {
	const md = 'Before\n\n$$\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\n$$\n\nAfter\n';
	assert.ok(types(md).includes('math'));
	assert.equal(roundTrip(md), md);
});
