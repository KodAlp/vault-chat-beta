import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelId, lookupFamily, capsFor, isEmbeddingOnly, modelInfoFor, compatModelExtras } from './model-caps';

const REASONING = { tools: true, reasoning: true };
const NONE = { tools: false, reasoning: false };

test('normalizeModelId: lowercases, strips directory/org prefix and .gguf, unifies - _ :', () => {
	assert.equal(normalizeModelId('qwen3:8b'), 'qwen3-8b');
	assert.equal(normalizeModelId('Qwen3-8B-Q4_K_M.gguf'), 'qwen3-8b-q4-k-m');
	assert.equal(normalizeModelId('C:\\models\\qwen3-8b.gguf'), 'qwen3-8b');
	assert.equal(normalizeModelId('/home/me/models/Qwen3-8B.GGUF'), 'qwen3-8b');
	assert.equal(normalizeModelId('qwen/qwen3-8b'), 'qwen3-8b');
	assert.equal(normalizeModelId('Qwen/Qwen3-8B'), 'qwen3-8b');
	assert.equal(normalizeModelId('qwen/qwen3-30b-a3b:free'), 'qwen3-30b-a3b-free');
	assert.equal(normalizeModelId('hf.co/Qwen/Qwen3-8B-GGUF:Q4_K_M'), 'qwen3-8b-gguf-q4-k-m');
});

test('every server spelling of the qwen3 family resolves to the same caps', () => {
	for (const id of [
		'qwen3:8b',
		'qwen3:8b-bart-iq4xs',
		'Qwen3-8B-Q4_K_M.gguf',
		'C:\\models\\qwen3-8b.gguf',
		'qwen/qwen3-8b',
		'Qwen/Qwen3-8B',
		'qwen/qwen3-30b-a3b',
		'qwen/qwen3-30b-a3b:free'
	]) {
		assert.deepEqual(capsFor(id), REASONING, id);
	}
});

test('a different family never matches: qwen2.5, qwen2, qwq, llama3.2, mistral, gemma3', () => {
	for (const id of ['qwen2.5:7b', 'Qwen2.5-7B-Instruct.gguf', 'qwen/qwen2.5-72b-instruct', 'qwen2:7b', 'qwq:32b', 'llama3.2:3b', 'mistral', 'gemma3:4b', 'meta-llama/Llama-3.1-8B']) {
		assert.deepEqual(capsFor(id), NONE, id);
		assert.equal(lookupFamily(id), undefined, id);
	}
});

test('embedding models are embedding-only in every spelling, and qwen3-embedding is not mistaken for the qwen3 chat family', () => {
	for (const id of [
		'bge-m3',
		'bge-m3:latest',
		'BAAI/bge-m3',
		'bge_m3.gguf',
		'nomic-embed-text',
		'nomic-embed-text:v1.5',
		'text-embedding-nomic-embed-text-v1.5',
		'nomic-ai/nomic-embed-text-v1.5-GGUF',
		'qwen3-embedding:8b',
		'Qwen/Qwen3-Embedding-0.6B',
		'Qwen3-Embedding-0.6B-Q8_0.gguf',
		'mxbai-embed-large',
		'text-embedding-3-small',
		'gte-large',
		'e5-mistral-7b-instruct'
	]) {
		assert.equal(isEmbeddingOnly(id), true, id);
		assert.deepEqual(capsFor(id), NONE, id);
	}
});

test('chat models are never embedding-only', () => {
	for (const id of ['qwen3:8b', 'Qwen/Qwen3-8B', 'llama3.2:3b', 'mistral', 'qwen/qwen3-30b-a3b', 'gpt-4o', 'deepseek-chat']) {
		assert.equal(isEmbeddingOnly(id), false, id);
	}
});

test('an override wins over the table, flag by flag; absent flags fall through', () => {
	assert.deepEqual(capsFor('qwen3:8b', { tools: false }), { tools: false, reasoning: true });
	assert.deepEqual(capsFor('qwen3:8b', { reasoning: false }), { tools: true, reasoning: false });
	assert.deepEqual(capsFor('my-custom-model', { tools: true }), { tools: true, reasoning: false });
	assert.deepEqual(capsFor('my-custom-model', { tools: true, reasoning: true }), REASONING);
	assert.deepEqual(capsFor('qwen3:8b', {}), REASONING);
});

// OllamaAdapter keeps its exact pre-move behavior for the ids Ollama actually lists.
test('Ollama ids: modelInfoFor is identical to the old ollama.ts table lookup (ctx, serveCtx, caps, flags)', () => {
	assert.deepEqual(modelInfoFor('qwen3:8b'), {
		id: 'qwen3:8b',
		ctx: 40960,
		serveCtx: 8192,
		caps: REASONING,
		prefixResume: true
	});
	assert.deepEqual(modelInfoFor('qwen3:8b-bart-iq4xs').caps, REASONING);
	assert.deepEqual(modelInfoFor('nomic-embed-text:latest'), { id: 'nomic-embed-text:latest', ctx: 2048, caps: NONE, embeddingOnly: true });
	assert.deepEqual(modelInfoFor('bge-m3:latest'), { id: 'bge-m3:latest', ctx: 8192, caps: NONE, embeddingOnly: true });
	assert.deepEqual(modelInfoFor('llama3.2:3b'), { id: 'llama3.2:3b', ctx: 8192, caps: NONE });
	assert.deepEqual(modelInfoFor('mistral'), { id: 'mistral', ctx: 8192, caps: NONE });
});

test('lookupFamily exposes serveCtx and prefixResume for qwen3 only (Ollama-only concerns)', () => {
	assert.equal(lookupFamily('qwen3:8b')?.serveCtx, 8192);
	assert.equal(lookupFamily('qwen3:8b')?.prefixResume, true);
	assert.equal(lookupFamily('llama3.2:3b')?.prefixResume, undefined);
	assert.equal(lookupFamily('bge-m3')?.prefixResume, undefined);
});

test('compatModelExtras: caps plus embeddingOnly only when true, no serveCtx/prefixResume leakage', () => {
	assert.deepEqual(compatModelExtras('qwen/qwen3-8b'), { caps: REASONING });
	assert.deepEqual(compatModelExtras('some-chat-model'), { caps: NONE });
	assert.deepEqual(compatModelExtras('text-embedding-nomic-embed-text-v1.5'), { caps: NONE, embeddingOnly: true });
	assert.deepEqual(compatModelExtras('some-chat-model', { tools: true }), { caps: { tools: true, reasoning: false } });
});
