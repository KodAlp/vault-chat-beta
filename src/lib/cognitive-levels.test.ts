import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COGNITIVE_LEVELS, LEVEL_MENU, assignLevels, isCognitiveLevel } from './cognitive-levels';

test('four levels, from least to most demanding', () => {
	assert.deepEqual([...COGNITIVE_LEVELS], ['recall', 'understanding', 'application', 'higher']);
});

test('isCognitiveLevel accepts exactly the four and nothing else', () => {
	for (const l of COGNITIVE_LEVELS) assert.equal(isCognitiveLevel(l), true, l);
	for (const v of ['analysis', 'synthesis', 'transfer', 'Recall', 'retention', '', null, undefined, 3]) assert.equal(isCognitiveLevel(v), false, String(v));
});

test('multiple choice is never dealt "higher" (measured: the judge agreed with 1 of 6 and 0 of 5)', () => {
	assert.equal(LEVEL_MENU.multiple_choice.includes('higher'), false);
	assert.equal(assignLevels('multiple_choice', 12, Array(12).fill(true)).includes('higher'), false);
	assert.equal(LEVEL_MENU.open.includes('higher'), true, 'open questions keep it');
});

test('every menu only offers real levels, and true/false never claims to apply a method', () => {
	for (const menu of Object.values(LEVEL_MENU)) for (const l of menu) assert.equal(isCognitiveLevel(l), true, l);
	assert.equal(LEVEL_MENU.true_false.includes('application'), false);
	assert.equal(LEVEL_MENU.true_false.includes('higher'), false);
});

test('without part information a 4/2/4 quiz is dealt a spread of levels that fit each type', () => {
	assert.deepEqual(assignLevels('multiple_choice', 4), ['recall', 'understanding', 'application', 'recall']);
	assert.deepEqual(assignLevels('true_false', 2), ['recall', 'understanding']);
	assert.deepEqual(assignLevels('open', 4), ['application', 'higher', 'understanding', 'application']);
});

test('the deal cycles for more questions than the menu and handles zero', () => {
	assert.deepEqual(assignLevels('true_false', 5), ['recall', 'understanding', 'recall', 'understanding', 'recall']);
	assert.deepEqual(assignLevels('open', 0), []);
	assert.deepEqual(assignLevels('open', -3), []);
});

test('a part without material to apply is never dealt "application"', () => {
	const none = [false, false, false, false];
	for (const kind of ['multiple_choice', 'true_false', 'open'] as const) {
		assert.equal(assignLevels(kind, 4, none).includes('application'), false, kind);
	}
	// the open menu starts with application; without support the deal moves on and still varies
	assert.deepEqual(assignLevels('open', 4, none), ['higher', 'understanding', 'higher', 'understanding']);
	assert.deepEqual(assignLevels('multiple_choice', 4, none), ['recall', 'understanding', 'recall', 'understanding']);
});

test('application goes exactly to the parts that support it, when the menu offers it', () => {
	// slot 0 supports, slot 1 does not, slot 2 supports
	assert.deepEqual(assignLevels('open', 3, [true, false, true]), ['application', 'higher', 'understanding']);
	const mc = assignLevels('multiple_choice', 4, [false, false, true, false]);
	assert.equal(mc[2], 'application');
	assert.equal(mc.filter((l) => l === 'application').length, 1);
});

test('a missing or short `supports` list treats the unknown slots as unable', () => {
	assert.equal(assignLevels('open', 2, [true]).at(1) === 'application', false);
});
