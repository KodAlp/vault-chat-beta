import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveCtxOverride } from './env';

function withServeCtx(value: string | undefined, fn: () => void) {
	const prev = process.env.OLLAMA_SERVE_CTX;
	if (value === undefined) delete process.env.OLLAMA_SERVE_CTX;
	else process.env.OLLAMA_SERVE_CTX = value;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env.OLLAMA_SERVE_CTX;
		else process.env.OLLAMA_SERVE_CTX = prev;
	}
}

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
