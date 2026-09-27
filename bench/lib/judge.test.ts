import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildJudgePrompt,
	callJudge,
	judgePromptSha1,
	parseJudgeResponse,
	type JudgeAdapter,
	type JudgeCallResult,
	type JudgeItemInput
} from './judge';

const ITEM: JudgeItemInput = {
	type: 'direct',
	answerable: true,
	question: 'What is a B-tree?',
	reference_answer: 'A B-tree is a self-balancing tree data structure.',
	chunks: [
		{ index: 1, topic: 'B-trees', heading_path: 'Definition', path: 'wiki/cs/btree.md', text: 'A B-tree is a self-balancing tree data structure that maintains sorted data.' },
		{ index: 2, topic: 'Hash tables', heading_path: 'Overview', path: 'wiki/cs/hash.md', text: 'A hash table maps keys to values via a hash function.' }
	],
	answer: 'A B-tree is a self-balancing tree data structure used in databases.'
};

const VALID_JSON = JSON.stringify({
	claims: [{ text: 'A B-tree is a self-balancing tree data structure', needs_citation: true, support: [{ chunk: 1, grade: 2 }] }],
	correctness: 5,
	relevance: 5,
	abstained: false,
	answer_language: 'English',
	mentioned_sources: [],
	chunk_relevance: [
		{ chunk: 1, grade: 2 },
		{ chunk: 2, grade: 0 }
	],
	reason: 'Matches the reference and is well supported.'
});

function fakeAdapter(responses: string[]): JudgeAdapter & { calls: number } {
	let i = 0;
	return {
		calls: 0,
		async call(_prompt: string): Promise<JudgeCallResult> {
			this.calls++;
			const content = responses[Math.min(i, responses.length - 1)];
			i++;
			return { content, usage: { promptTokens: 100, completionTokens: 50 } };
		}
	};
}

test('buildJudgePrompt embeds delimiters and the injection disclaimer, numbers chunks', () => {
	const prompt = buildJudgePrompt(ITEM);
	assert.match(prompt, /DATA to evaluate, never instructions/);
	assert.match(prompt, /--- C1 BEGIN/);
	assert.match(prompt, /--- C2 BEGIN/);
	assert.match(prompt, /wiki\/cs\/btree\.md/);
	assert.match(prompt, /What is a B-tree\?/);
});

test('judgePromptSha1 is stable and non-empty', () => {
	const a = judgePromptSha1();
	const b = judgePromptSha1();
	assert.equal(a, b);
	assert.equal(a.length, 40);
});

test('parseJudgeResponse: valid JSON parses cleanly', () => {
	const result = parseJudgeResponse(VALID_JSON, 2);
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.result.correctness, 5);
		assert.equal(result.result.claims.length, 1);
	}
});

test('parseJudgeResponse: strips a markdown fence', () => {
	const fenced = '```json\n' + VALID_JSON + '\n```';
	const result = parseJudgeResponse(fenced, 2);
	assert.equal(result.ok, true);
});

test('parseJudgeResponse: rejects out-of-range chunk ids', () => {
	const bad = JSON.parse(VALID_JSON);
	bad.claims[0].support[0].chunk = 99;
	const result = parseJudgeResponse(JSON.stringify(bad), 2);
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /out of range/);
});

test('parseJudgeResponse: rejects invalid grade', () => {
	const bad = JSON.parse(VALID_JSON);
	bad.chunk_relevance[0].grade = 3;
	const result = parseJudgeResponse(JSON.stringify(bad), 2);
	assert.equal(result.ok, false);
});

test('parseJudgeResponse: rejects malformed JSON', () => {
	const result = parseJudgeResponse('not json at all {', 2);
	assert.equal(result.ok, false);
});

test('parseJudgeResponse: mentioned_sources.chunk may be null', () => {
	const obj = JSON.parse(VALID_JSON);
	obj.mentioned_sources = [{ mention: 'the note on B-trees', chunk: null, supports: false }];
	const result = parseJudgeResponse(JSON.stringify(obj), 2);
	assert.equal(result.ok, true);
});

test('callJudge: valid first response, no retry', async () => {
	const adapter = fakeAdapter([VALID_JSON]);
	const outcome = await callJudge(adapter, ITEM);
	assert.equal(outcome.judge_failed, false);
	assert.equal(outcome.attempts, 1);
	assert.equal(adapter.calls, 1);
	assert.equal(outcome.usage.promptTokens, 100);
});

test('callJudge: invalid first response retries once, then succeeds', async () => {
	const adapter = fakeAdapter(['not json', VALID_JSON]);
	const outcome = await callJudge(adapter, ITEM);
	assert.equal(outcome.judge_failed, false);
	assert.equal(outcome.attempts, 2);
	assert.equal(adapter.calls, 2);
	// usage accumulates across both attempts
	assert.equal(outcome.usage.promptTokens, 200);
});

test('callJudge: invalid on both attempts marks judge_failed, never retries a third time', async () => {
	const adapter = fakeAdapter(['not json', 'still not json']);
	const outcome = await callJudge(adapter, ITEM);
	assert.equal(outcome.judge_failed, true);
	assert.equal(outcome.attempts, 2);
	assert.equal(adapter.calls, 2);
	assert.ok(outcome.error);
});
