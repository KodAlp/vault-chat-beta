import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctxFill, isNearCtxLimit, NEAR_CTX_LIMIT, parseOllamaDone, type UsageChunk } from './ollama-usage';

// The exact final line a live Ollama 0.32.5 returned (message/context dropped).
const REAL_DONE = {
	done: true,
	done_reason: 'stop',
	total_duration: 37357928800,
	load_duration: 4928658400,
	prompt_eval_count: 8362,
	prompt_eval_duration: 8657885000,
	eval_count: 85,
	eval_duration: 23750582000
};

test('a real final line maps to a usage chunk, nanoseconds to milliseconds', () => {
	const u = parseOllamaDone(REAL_DONE, 16384);
	assert.deepEqual(u, {
		type: 'usage',
		prompt: 8362,
		completion: 85,
		numCtx: 16384,
		promptMs: 8658,
		completionMs: 23751,
		loadMs: 4929
	});
});

test('a line that is not the final one yields null', () => {
	assert.equal(parseOllamaDone({ done: false, prompt_eval_count: 5 }, 8192), null);
	assert.equal(parseOllamaDone({}, 8192), null);
});

test('a final line with neither token count yields null — zeros would read as a measurement', () => {
	assert.equal(parseOllamaDone({ done: true, load_duration: 1e9 }, 8192), null);
});

test('one missing count defaults to 0, a missing duration is omitted rather than invented', () => {
	const u = parseOllamaDone({ done: true, eval_count: 40 }, 8192);
	assert.ok(u);
	assert.equal(u.prompt, 0);
	assert.equal(u.completion, 40);
	assert.equal('promptMs' in u, false);
	assert.equal('completionMs' in u, false);
	assert.equal('loadMs' in u, false);
});

test('non-numeric and non-finite values are ignored', () => {
	const u = parseOllamaDone(
		{ done: true, prompt_eval_count: 10, eval_count: 5, load_duration: Number.NaN, prompt_eval_duration: '9' as unknown as number },
		8192
	);
	assert.ok(u);
	assert.equal('loadMs' in u, false);
	assert.equal('promptMs' in u, false);
});

function usage(prompt: number, completion: number, numCtx?: number): UsageChunk {
	return { type: 'usage', prompt, completion, ...(numCtx === undefined ? {} : { numCtx }) };
}

test('ctxFill is (prompt+completion)/numCtx, undefined without a window', () => {
	assert.equal(ctxFill(usage(6000, 1000, 8192)), 7000 / 8192);
	assert.equal(ctxFill(usage(6000, 1000)), undefined);
	assert.equal(ctxFill(usage(6000, 1000, 0)), undefined);
});

test('isNearCtxLimit trips at the threshold, not below it', () => {
	const ctx = 10000;
	assert.equal(isNearCtxLimit(usage(NEAR_CTX_LIMIT * ctx - 1, 0, ctx)), false);
	assert.equal(isNearCtxLimit(usage(NEAR_CTX_LIMIT * ctx, 0, ctx)), true);
	assert.equal(isNearCtxLimit(usage(ctx, 0, ctx)), true);
});

test('isNearCtxLimit is false, not true, when the window is unknown', () => {
	assert.equal(isNearCtxLimit(usage(99999, 99999)), false);
});
