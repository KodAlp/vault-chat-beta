import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatAdapter } from './openai-compat';

const TIMEOUTS = { connectMs: 5000, firstTokenMs: 30000, idleMs: 30000 };

function adapter(): OpenAICompatAdapter {
	return new OpenAICompatAdapter({ id: 'test-provider', baseUrl: 'https://example.test/v1', reasoningDialect: 'none', timeouts: TIMEOUTS });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
	return () => (globalThis.fetch = realFetch);
}

test('listModels sends an AbortSignal on the /models request (F14-1 — health() already did, this one did not)', async () => {
	let sawSignal: AbortSignal | undefined;
	const restore = stubFetch((url, init) => {
		sawSignal = init?.signal ?? undefined;
		return new Response(JSON.stringify({ data: [] }), { status: 200 });
	});
	try {
		await adapter().listModels();
		assert.ok(sawSignal instanceof AbortSignal, 'a signal was attached to the request');
	} finally {
		restore();
	}
});

test('listModels maps id and, when present, created — ctx/caps stay the existing placeholder defaults', async () => {
	const restore = stubFetch(() =>
		new Response(JSON.stringify({ data: [{ id: 'model-a', created: 1700000000 }, { id: 'model-b' }] }), { status: 200 })
	);
	try {
		const models = await adapter().listModels();
		assert.deepEqual(models, [
			{ id: 'model-a', ctx: 8192, caps: { tools: false, reasoning: false }, created: 1700000000 },
			{ id: 'model-b', ctx: 8192, caps: { tools: false, reasoning: false } }
		]);
	} finally {
		restore();
	}
});

test('listModels returns [] on a non-ok response, never throws', async () => {
	const restore = stubFetch(() => new Response('nope', { status: 500 }));
	try {
		assert.deepEqual(await adapter().listModels(), []);
	} finally {
		restore();
	}
});

test('listModels returns [] when the request itself fails (network error, abort), never throws', async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw new Error('fetch failed');
	}) as typeof fetch;
	try {
		assert.deepEqual(await adapter().listModels(), []);
	} finally {
		globalThis.fetch = realFetch;
	}
});
