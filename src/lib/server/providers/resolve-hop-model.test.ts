import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHopModel } from './resolve-hop-model';
import type { ProviderConfigEntry } from './config-store';

function entry(defaultModel?: string): ProviderConfigEntry {
	return {
		id: 'x',
		label: 'X',
		baseUrl: 'https://example.invalid',
		kind: 'openai-compat',
		reasoningDialect: 'none',
		enabled: true,
		timeouts: { connectMs: 1, firstTokenMs: 1, idleMs: 1 },
		defaultModel
	};
}

test('hop 0 always passes the requested model through, regardless of the entry', () => {
	assert.equal(resolveHopModel(0, entry('some-other-model'), 'deepseek-flash'), 'deepseek-flash');
	assert.equal(resolveHopModel(0, undefined, 'deepseek-flash'), 'deepseek-flash');
});

test('a later hop substitutes its own provider\'s defaultModel, not the requested one', () => {
	assert.equal(resolveHopModel(1, entry('qwen3:8b'), 'deepseek-flash'), 'qwen3:8b');
	assert.equal(resolveHopModel(2, entry('qwen3:8b'), 'deepseek-flash'), 'qwen3:8b');
});

test('a later hop with no defaultModel configured is skipped (null), never asked for the wrong model', () => {
	assert.equal(resolveHopModel(1, entry(undefined), 'deepseek-flash'), null);
	assert.equal(resolveHopModel(1, undefined, 'deepseek-flash'), null);
});
