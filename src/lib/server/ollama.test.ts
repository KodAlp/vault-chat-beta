import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embed } from './ollama';
import { EMBED_MODEL } from './embed-config';

const BASE_URL = 'http://10.1.2.3:11434';

/** Swaps global fetch for one that records the request and answers like
 * Ollama's /api/embed. EMBED_MODEL is declared resident in ollama-gate, so
 * embed() never reaches the gate's own network calls in these tests. */
async function capture(status = 200) {
	const seen: { url: string; body: Record<string, unknown> }[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
		seen.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
		return new Response(JSON.stringify({ embeddings: [[0.5, 0.25]] }), { status });
	}) as typeof fetch;
	return { seen, restore: () => (globalThis.fetch = realFetch) };
}

test('by default no options are sent, so bulk indexing keeps using the GPU', async () => {
	const { seen, restore } = await capture();
	try {
		const out = await embed(['a', 'b'], EMBED_MODEL, { baseUrl: BASE_URL });
		assert.deepEqual(out, [[0.5, 0.25]]);
		assert.equal(seen[0].url, BASE_URL + '/api/embed', 'the URL comes from the passed baseUrl, never from env');
		assert.deepEqual(seen[0].body, { model: EMBED_MODEL, input: ['a', 'b'] });
		assert.equal('options' in seen[0].body, false);
	} finally {
		restore();
	}
});

test('cpuOnly asks Ollama to keep the embedding model off the GPU', async () => {
	const { seen, restore } = await capture();
	try {
		await embed(['query'], EMBED_MODEL, { cpuOnly: true, baseUrl: BASE_URL });
		assert.deepEqual(seen[0].body, { model: EMBED_MODEL, input: ['query'], options: { num_gpu: 0 } });
	} finally {
		restore();
	}
});

test('cpuOnly: false behaves exactly like the default', async () => {
	const { seen, restore } = await capture();
	try {
		await embed(['query'], EMBED_MODEL, { cpuOnly: false, baseUrl: BASE_URL });
		assert.equal('options' in seen[0].body, false);
	} finally {
		restore();
	}
});

test('a non-OK response still throws, with or without cpuOnly', async () => {
	const { restore } = await capture(500);
	try {
		await assert.rejects(() => embed(['q'], EMBED_MODEL, { cpuOnly: true, baseUrl: BASE_URL }), /\/api\/embed 500/);
	} finally {
		restore();
	}
});
