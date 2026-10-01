import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoPickModel, emptyChainTasks, chooseEmbeddingCandidate, modelListed } from './setup-choices';

test('autoPickModel picks only when the server lists exactly one chat model', () => {
	assert.equal(autoPickModel(['qwen3:8b']), 'qwen3:8b');
	assert.equal(autoPickModel([]), null);
	assert.equal(autoPickModel(['a', 'b']), null);
});

test('emptyChainTasks returns only the empty chains, leaving configured ones alone', () => {
	assert.deepEqual(emptyChainTasks({ chat: [], title: ['ollama'], quiz: [], slides: ['groq', 'ollama'] }), ['chat', 'quiz']);
	assert.deepEqual(emptyChainTasks({ chat: ['ollama'] }), []);
	assert.deepEqual(emptyChainTasks({}), []);
});

test('chooseEmbeddingCandidate prefers bge-m3 (any tag), then the first listed, else none', () => {
	assert.equal(chooseEmbeddingCandidate(['nomic-embed-text:latest', 'bge-m3:latest']), 'bge-m3:latest');
	assert.equal(chooseEmbeddingCandidate(['nomic-embed-text:latest']), 'nomic-embed-text:latest');
	assert.equal(chooseEmbeddingCandidate([]), null);
	assert.equal(chooseEmbeddingCandidate(['text-embedding-nomic-embed-text-v1.5']), 'text-embedding-nomic-embed-text-v1.5');
});

test('modelListed: base+tag matching as the wizard has always done it', () => {
	assert.equal(modelListed(['bge-m3:latest'], 'bge-m3'), true);
	assert.equal(modelListed(['qwen3:8b'], 'qwen3:8b'), true);
	assert.equal(modelListed(['qwen3:4b'], 'qwen3:8b'), false);
	assert.equal(modelListed(['llama3'], 'qwen3:8b'), false);
});
