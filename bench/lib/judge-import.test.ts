import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planImport, parseJsonl, type DumpedPrompt } from './judge-import';

const prompts: DumpedPrompt[] = [
	{ key: 'm:a', id: 'q1', numChunks: 2, prompt: 'p1' },
	{ key: 'm:b', id: 'q2', numChunks: 2, prompt: 'p2' },
	{ key: 'm:c', id: 'q3', numChunks: 2, prompt: 'p3' }
];

test('planImport: invalid, missing, unknown key and cached keys are counted; cache lines are never produced for them', () => {
	const plan = planImport(
		prompts,
		[
			{ key: 'm:a', raw: 'not json at all' },
			{ key: 'm:zzz', raw: '{}' }
		],
		new Set(['m:c'])
	);
	assert.equal(plan.ok, 0);
	assert.equal(plan.lines.length, 0);
	assert.equal(plan.invalid.length, 2);
	assert.equal(plan.invalid[0].id, 'q1');
	assert.equal(plan.invalid[1].error, 'key not in --prompts');
	assert.deepEqual(plan.missing.map((m) => m.id), ['q2', 'q3']);
});

test('parseJsonl skips blank and truncated lines', () => {
	assert.deepEqual(parseJsonl<{ a: number }>('{"a":1}\n\n{"a":'), [{ a: 1 }]);
});

test('planImport: a valid response becomes one cache line {key,id,result}; an already-cached key is not rewritten', () => {
	const raw = JSON.stringify({
		claims: [{ text: 'x', needs_citation: true, support: [{ chunk: 1, grade: 2 }] }],
		correctness: 4,
		relevance: 5,
		abstained: false,
		answer_language: 'tr',
		mentioned_sources: [],
		chunk_relevance: [{ chunk: 1, grade: 2 }],
		reason: 'ok'
	});
	const plan = planImport(prompts, [{ key: 'm:a', raw }, { key: 'm:b', raw: '```json\n' + raw + '\n```' }, { key: 'm:c', raw }], new Set(['m:c']));
	assert.equal(plan.ok, 2);
	assert.equal(plan.alreadyCached, 1);
	assert.equal(plan.missing.length, 0);
	const first = JSON.parse(plan.lines[0]);
	assert.equal(first.key, 'm:a');
	assert.equal(first.id, 'q1');
	assert.equal(first.result.correctness, 4);
});
