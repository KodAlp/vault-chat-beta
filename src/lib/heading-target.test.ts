import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHeading, pickHeadingIndex } from './heading-target';

test('normalizeHeading drops Markdown marks, links and case', () => {
	assert.equal(normalizeHeading('**Key** `claims`'), 'key claims');
	assert.equal(normalizeHeading('See [Pipelining](wiki/asm/x.md)  now'), 'see pipelining now');
	assert.equal(normalizeHeading('$O(n)$ bound'), 'o(n) bound');
});

test('pickHeadingIndex skips the title segment and finds the section', () => {
	const hs = [
		{ level: 2, text: 'Intro' },
		{ level: 2, text: 'Hazards (the reasons pipelining isn’t free)' }
	];
	assert.equal(pickHeadingIndex(hs, 'Instruction Pipelining > Hazards (the reasons pipelining isn’t free)'), 1);
	assert.equal(pickHeadingIndex(hs, 'Instruction Pipelining'), -1);
	assert.equal(pickHeadingIndex(hs, 'Instruction Pipelining > Missing'), -1);
});

test('pickHeadingIndex prefers the repeated title under the matching parent', () => {
	const hs = [
		{ level: 2, text: 'Sorting' },
		{ level: 3, text: 'Example' },
		{ level: 2, text: 'Searching' },
		{ level: 3, text: 'Notes' },
		{ level: 3, text: 'Example' }
	];
	assert.equal(pickHeadingIndex(hs, 'Algo > Searching > Example'), 4);
	assert.equal(pickHeadingIndex(hs, 'Algo > Sorting > Example'), 1);
	assert.equal(pickHeadingIndex(hs, 'Algo > Other > Example'), 1);
});
