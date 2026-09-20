import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaAdapter } from './ollama';
import type { ChatRequest, Chunk } from './types';

const TIMEOUTS = { connectMs: 5000, firstTokenMs: 5000, idleMs: 5000 };
// One model name throughout: the shared ollamaGate is a process-wide singleton, and
// a second model would make it try to unload the first over the (stubbed) network.
const MODEL = 'qwen3:8b';

function ndjson(...lines: object[]): string {
	return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** Replaces global fetch: records every /api/chat request body and answers with
 * the given NDJSON stream, like Ollama's native chat endpoint. */
function stubOllama(stream: string) {
	const bodies: Record<string, unknown>[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
		const u = String(url);
		if (u.endsWith('/api/chat')) {
			bodies.push(JSON.parse(init?.body ?? '{}'));
			return new Response(stream, { status: 200 });
		}
		if (u.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }), { status: 200 });
		return new Response('{}', { status: 200 });
	}) as typeof fetch;
	return { bodies, restore: () => (globalThis.fetch = realFetch) };
}

async function collect(gen: AsyncGenerator<Chunk>): Promise<Chunk[]> {
	const out: Chunk[] = [];
	for await (const c of gen) out.push(c);
	return out;
}

const STREAM = ndjson(
	{ message: { role: 'assistant', content: ' Bu' }, done: false },
	{ message: { role: 'assistant', content: ' yapı' }, done: false },
	{ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 3 }
);

function adapter() {
	return new OllamaAdapter('ollama', 'http://127.0.0.1:1', TIMEOUTS);
}

test('a trailing assistant message reaches Ollama untouched, as the last wire message', async () => {
	const { bodies, restore } = stubOllama(STREAM);
	try {
		const req: ChatRequest = {
			model: MODEL,
			messages: [
				{ role: 'system', content: 'sistem' },
				{ role: 'user', content: 'soru' },
				{ role: 'assistant', content: 'B-tree, dengeli ağaç yapısı sayesinde her seviyede eşit' }
			],
			continuation: true
		};
		const chunks = await collect(adapter().chat(req, new AbortController().signal));
		assert.deepEqual(
			(bodies[0].messages as { role: string; content: string }[]).map((m) => m.role),
			['system', 'user', 'assistant']
		);
		assert.equal((bodies[0].messages as { content: string }[]).at(-1)?.content, 'B-tree, dengeli ağaç yapısı sayesinde her seviyede eşit');
		assert.deepEqual(
			chunks.filter((c) => c.type === 'text'),
			[
				{ type: 'text', text: ' Bu' },
				{ type: 'text', text: ' yapı' }
			]
		);
		assert.equal(chunks.at(-1)?.type, 'done');
	} finally {
		restore();
	}
});

test('stop strings are sent as options.stop', async () => {
	const { bodies, restore } = stubOllama(STREAM);
	try {
		await collect(
			adapter().chat({ model: MODEL, messages: [{ role: 'user', content: 'x' }], stop: ['</think>', '<think>'] }, new AbortController().signal)
		);
		const options = bodies[0].options as Record<string, unknown>;
		assert.deepEqual(options.stop, ['</think>', '<think>']);
	} finally {
		restore();
	}
});

test('without stop, no stop key is sent — the model keeps its own stops', async () => {
	const { bodies, restore } = stubOllama(STREAM);
	try {
		await collect(adapter().chat({ model: MODEL, messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal));
		const options = bodies[0].options as Record<string, unknown>;
		assert.equal('stop' in options, false);
		assert.equal(typeof options.num_ctx, 'number');
	} finally {
		restore();
	}
});

test('an empty stop list is treated as no stop list', async () => {
	const { bodies, restore } = stubOllama(STREAM);
	try {
		await collect(adapter().chat({ model: MODEL, messages: [{ role: 'user', content: 'x' }], stop: [] }, new AbortController().signal));
		assert.equal('stop' in (bodies[0].options as Record<string, unknown>), false);
	} finally {
		restore();
	}
});

test('supportsPrefixResume is true only for the verified qwen3 family', () => {
	const a = adapter();
	assert.equal(a.supportsPrefixResume('qwen3:8b'), true);
	assert.equal(a.supportsPrefixResume('qwen3:8b-bart-iq4xs'), true);
	assert.equal(a.supportsPrefixResume('llama3.2:3b'), false);
	assert.equal(a.supportsPrefixResume('bge-m3:latest'), false);
	assert.equal(a.supportsPrefixResume('mistral'), false);
});
