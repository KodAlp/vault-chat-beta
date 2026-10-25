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

test('listModels sends an AbortSignal on the /models request (health() already did, this one did not)', async () => {
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

// Capability flags from the shared table, embedding-only drop, and chat_template_kwargs.
function localAdapter(opts: { local?: boolean; modelCaps?: Record<string, { tools?: boolean; reasoning?: boolean }> } = {}): OpenAICompatAdapter {
	return new OpenAICompatAdapter({
		id: 'lmstudio',
		baseUrl: 'http://127.0.0.1:1234/v1',
		reasoningDialect: 'reasoning_content',
		timeouts: TIMEOUTS,
		...opts
	});
}

const SSE = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';

async function chatBody(a: OpenAICompatAdapter, req: Partial<Parameters<OpenAICompatAdapter['chat']>[0]>): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> = {};
	const restore = stubFetch((_url, init) => {
		body = JSON.parse(String(init?.body));
		return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
	});
	try {
		for await (const _chunk of a.chat({ model: 'qwen/qwen3-8b', messages: [{ role: 'user', content: 'x' }], ...req }, new AbortController().signal)) {
			// drain
		}
	} finally {
		restore();
	}
	return body;
}

test('listModels fills caps from the shared table (LM Studio style ids) and marks embedding models embeddingOnly', async () => {
	const restore = stubFetch(() =>
		new Response(
			JSON.stringify({
				data: [{ id: 'qwen/qwen3-8b' }, { id: 'llama-3.2-3b-instruct' }, { id: 'text-embedding-nomic-embed-text-v1.5' }, { id: 'Qwen3-Embedding-0.6B-Q8_0.gguf' }]
			}),
			{ status: 200 }
		)
	);
	try {
		const models = await localAdapter().listModels();
		assert.deepEqual(models[0].caps, { tools: true, reasoning: true });
		assert.equal(models[0].embeddingOnly, undefined);
		assert.deepEqual(models[1].caps, { tools: false, reasoning: false });
		assert.equal(models[2].embeddingOnly, true);
		assert.equal(models[3].embeddingOnly, true);
		assert.deepEqual(models.filter((m) => !m.embeddingOnly).map((m) => m.id), ['qwen/qwen3-8b', 'llama-3.2-3b-instruct']);
	} finally {
		restore();
	}
});

test('listModels applies the provider modelCaps override on top of the table', async () => {
	const restore = stubFetch(() => new Response(JSON.stringify({ data: [{ id: 'qwen/qwen3-8b' }, { id: 'my-model' }] }), { status: 200 }));
	try {
		const models = await localAdapter({ modelCaps: { 'qwen/qwen3-8b': { tools: false }, 'my-model': { tools: true, reasoning: true } } }).listModels();
		assert.deepEqual(models[0].caps, { tools: false, reasoning: true });
		assert.deepEqual(models[1].caps, { tools: true, reasoning: true });
	} finally {
		restore();
	}
});

test('local provider + think:false + a reasoning model sends chat_template_kwargs.enable_thinking=false', async () => {
	const body = await chatBody(localAdapter({ local: true }), { think: false });
	assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
});

test('think:true or think unset sends no chat_template_kwargs', async () => {
	assert.equal('chat_template_kwargs' in (await chatBody(localAdapter({ local: true }), { think: true })), false);
	assert.equal('chat_template_kwargs' in (await chatBody(localAdapter({ local: true }), {})), false);
});

test('a cloud entry (local false or unset) never gets chat_template_kwargs, even with think:false on a reasoning model', async () => {
	assert.equal('chat_template_kwargs' in (await chatBody(localAdapter({ local: false }), { think: false })), false);
	assert.equal('chat_template_kwargs' in (await chatBody(localAdapter(), { think: false })), false);
});

test('local + think:false but a model whose caps say no reasoning sends nothing extra', async () => {
	const body = await chatBody(localAdapter({ local: true }), { think: false, model: 'llama-3.2-3b-instruct' });
	assert.equal('chat_template_kwargs' in body, false);
});

test('the modelCaps override decides chat_template_kwargs too (force on for an unknown model, off for qwen3)', async () => {
	const on = await chatBody(localAdapter({ local: true, modelCaps: { 'my-model': { reasoning: true } } }), { think: false, model: 'my-model' });
	assert.deepEqual(on.chat_template_kwargs, { enable_thinking: false });
	const off = await chatBody(localAdapter({ local: true, modelCaps: { 'qwen/qwen3-8b': { reasoning: false } } }), { think: false });
	assert.equal('chat_template_kwargs' in off, false);
});

test('tools in the request are sent in the body as OpenAI function tools (the chat route gates them on modelCaps)', async () => {
	const body = await chatBody(localAdapter({ local: true }), {
		tools: [{ name: 'read_skill_file', description: 'd', parameters: { type: 'object', properties: {} } }]
	});
	assert.equal(Array.isArray(body.tools), true);
	assert.equal((body.tools as { function: { name: string } }[])[0].function.name, 'read_skill_file');
	assert.equal('tools' in (await chatBody(localAdapter({ local: true }), {})), false);
});
