import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evictForExclusiveJob } from './gpu-evict';

test('evicts when an Ollama provider is configured', async () => {
	let calls = 0;
	const did = await evictForExclusiveJob({
		getOllamaProviderId: () => 'ollama',
		evictAll: async () => {
			calls++;
		}
	});
	assert.equal(did, true);
	assert.equal(calls, 1);
});

test('does not evict when no Ollama provider is configured', async () => {
	let calls = 0;
	const did = await evictForExclusiveJob({
		getOllamaProviderId: () => null,
		evictAll: async () => {
			calls++;
		}
	});
	assert.equal(did, false);
	assert.equal(calls, 0);
});
