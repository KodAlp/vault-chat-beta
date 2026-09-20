import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatRetrievalK, DEFAULT_CHAT_RETRIEVAL_K, MAX_CHAT_RETRIEVAL_K, serveCtxOverride } from './env';

function withEnv(name: string, value: string | undefined, fn: () => void) {
	const prev = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env[name];
		else process.env[name] = prev;
	}
}

const withServeCtx = (value: string | undefined, fn: () => void) => withEnv('OLLAMA_SERVE_CTX', value, fn);
const withK = (value: string | undefined, fn: () => void) => withEnv('CHAT_RETRIEVAL_K', value, fn);

test('a positive integer is honoured', () => {
	withServeCtx('6144', () => assert.equal(serveCtxOverride(), 6144));
	withServeCtx(' 4096 ', () => assert.equal(serveCtxOverride(), 4096));
});

test('unset and empty mean "no override"', () => {
	withServeCtx(undefined, () => assert.equal(serveCtxOverride(), undefined));
	withServeCtx('', () => assert.equal(serveCtxOverride(), undefined));
});

test('a bad value is ignored, never coerced — a typo must not shrink every prompt', () => {
	for (const bad of ['abc', '0', '-4096', '4096.5', '8k', 'NaN', 'Infinity']) {
		withServeCtx(bad, () => assert.equal(serveCtxOverride(), undefined, `"${bad}" should be ignored`));
	}
});

test('chat k defaults to 6 when unset or empty', () => {
	assert.equal(DEFAULT_CHAT_RETRIEVAL_K, 6);
	withK(undefined, () => assert.equal(chatRetrievalK(), 6));
	withK('', () => assert.equal(chatRetrievalK(), 6));
});

test('chat k honours a value inside 1..MAX', () => {
	withK('1', () => assert.equal(chatRetrievalK(), 1));
	withK('12', () => assert.equal(chatRetrievalK(), 12));
	withK(String(MAX_CHAT_RETRIEVAL_K), () => assert.equal(chatRetrievalK(), MAX_CHAT_RETRIEVAL_K));
	withK(' 8 ', () => assert.equal(chatRetrievalK(), 8));
});

test('chat k falls back to the default on a bad value — never turns retrieval off or floods the prompt', () => {
	const bad = ['0', '-3', String(MAX_CHAT_RETRIEVAL_K + 1), '1000', '6.5', 'abc', '12k', 'NaN', 'Infinity'];
	for (const v of bad) {
		withK(v, () => assert.equal(chatRetrievalK(), DEFAULT_CHAT_RETRIEVAL_K, `"${v}" should fall back`));
	}
});

test('chat k is re-read on every call (a running server picks up a changed value)', () => {
	withK('9', () => assert.equal(chatRetrievalK(), 9));
	withK('4', () => assert.equal(chatRetrievalK(), 4));
});
