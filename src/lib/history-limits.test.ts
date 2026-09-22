import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimConversationHistory } from './history-limits';

const turn = (content: string) => ({ role: 'user' as const, content });

test('empty input returns empty output', () => {
	assert.deepEqual(trimConversationHistory([], 100), []);
});

test('everything fits: all turns kept, order preserved', () => {
	const turns = [turn('a'), turn('b'), turn('c')];
	assert.deepEqual(trimConversationHistory(turns, 100), turns);
});

test('over budget: oldest turns are dropped first, newest kept, order preserved', () => {
	const turns = [turn('aaaaa'), turn('bbbbb'), turn('ccccc')];
	// budget fits only the last two (5+5=10)
	const out = trimConversationHistory(turns, 10);
	assert.deepEqual(out, [turn('bbbbb'), turn('ccccc')]);
});

test('a single most-recent turn larger than the whole budget is still kept, not dropped to empty', () => {
	const turns = [turn('short'), turn('this one alone is already over budget')];
	const out = trimConversationHistory(turns, 5);
	assert.deepEqual(out, [turn('this one alone is already over budget')]);
});

test('exact boundary: a turn that exactly fits the remaining budget is kept', () => {
	const turns = [turn('12345'), turn('67890')];
	const out = trimConversationHistory(turns, 10);
	assert.deepEqual(out, turns);
});

test('default budget (MAX_HISTORY_CHARS) is used when maxChars is omitted', () => {
	const turns = [turn('x'.repeat(20000)), turn('y')];
	const out = trimConversationHistory(turns);
	assert.deepEqual(out, [turn('y')], 'the huge older turn is dropped under the real default budget');
});
