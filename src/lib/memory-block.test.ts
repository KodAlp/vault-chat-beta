import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryBlockText, type MemoryBlockInput } from './memory-block';
import { MEMORY_MAX_CHARS, MEMORY_MAX_NOTE_CHARS } from './memory-limits';

const empty: MemoryBlockInput = { notes: [], weakDomains: [], openWeakSpots: [] };

test('nothing to say: empty string, no bare header', () => {
	assert.equal(buildMemoryBlockText(empty), '');
});

test('a manual note alone produces a header and a bullet', () => {
	const out = buildMemoryBlockText({ ...empty, notes: [{ value: 'Kısa cevapları tercih ederim.' }] });
	assert.match(out, /^## /);
	assert.match(out, /- Kısa cevapları tercih ederim\.$/);
});

test('weak domains and open weak spots each get their own templated line', () => {
	const out = buildMemoryBlockText({
		...empty,
		weakDomains: [{ name: 'databases', masteryPct: 42 }],
		openWeakSpots: [{ noteName: 'scheduling', openErrors: 3 }]
	});
	assert.match(out, /Zayıf alanlar: databases \(~%42\)\./);
	assert.match(out, /Üzerinde durulacaklar: scheduling \(3\)\./);
});

test('multiple weak domains and weak spots are joined, not one line each', () => {
	const out = buildMemoryBlockText({
		...empty,
		weakDomains: [{ name: 'a', masteryPct: 10 }, { name: 'b', masteryPct: 20 }],
		openWeakSpots: [{ noteName: 'x', openErrors: 1 }, { noteName: 'y', openErrors: 2 }]
	});
	const lines = out.split('\n').filter((l) => l.startsWith('Zayıf') || l.startsWith('Üzerinde'));
	assert.equal(lines.length, 2);
});

test('a note longer than the per-note cap is trimmed with an ellipsis, not dropped', () => {
	const long = 'x'.repeat(MEMORY_MAX_NOTE_CHARS + 50);
	const out = buildMemoryBlockText({ ...empty, notes: [{ value: long }] });
	assert.ok(out.includes('…'));
	assert.ok(out.length < long.length + 20);
});

test('over budget: derived lines are dropped before any note is touched', () => {
	const notes = Array.from({ length: 3 }, (_, i) => ({ value: `not ${i}: ${'a'.repeat(200)}` }));
	const weakDomains = Array.from({ length: 20 }, (_, i) => ({ name: `domain${i}`, masteryPct: 10 }));
	const out = buildMemoryBlockText({ notes, weakDomains, openWeakSpots: [] });
	for (const n of notes) assert.ok(out.includes(n.value), 'every note survives while derived content is dropped first');
	assert.ok(out.length <= MEMORY_MAX_CHARS + 200, 'stays close to budget once derived content is fully dropped');
});

test('extreme over budget: oldest notes are dropped last, after all derived content is gone', () => {
	const notes = Array.from({ length: 30 }, (_, i) => ({ value: `not ${i}: ${'a'.repeat(100)}` }));
	const out = buildMemoryBlockText({ notes, weakDomains: [{ name: 'd', masteryPct: 5 }], openWeakSpots: [] });
	assert.ok(!out.includes('Zayıf alanlar'), 'derived content is gone first');
	assert.ok(out.includes(notes[0].value), 'the newest (first) note is kept over older ones');
	assert.ok(!out.includes(notes[29].value), 'the oldest (last) note is the first one dropped');
});

test('the result never exceeds the budget by more than one trimmed unit', () => {
	const notes = Array.from({ length: 5 }, (_, i) => ({ value: `${i} ${'a'.repeat(MEMORY_MAX_NOTE_CHARS)}` }));
	const out = buildMemoryBlockText({ notes, weakDomains: [], openWeakSpots: [] });
	assert.ok(out.length <= MEMORY_MAX_CHARS + MEMORY_MAX_NOTE_CHARS + 50);
});
