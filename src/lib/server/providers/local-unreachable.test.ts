import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unreachableLocalServerLabel } from './local-unreachable';
import { ProviderError } from './types';

const ENTRIES = [
	{ id: 'ollama', label: 'Ollama (yerel)', kind: 'ollama' as const },
	{ id: 'lmstudio', label: 'LM Studio', kind: 'openai-compat' as const, local: true },
	{ id: 'groq', label: 'Groq', kind: 'openai-compat' as const }
];

test('a connect failure on Ollama or on a local openai-compat provider names that provider', () => {
	assert.equal(unreachableLocalServerLabel(new ProviderError('network', 'ollama', 'x'), ENTRIES), 'Ollama (yerel)');
	assert.equal(unreachableLocalServerLabel(new ProviderError('timeout_connect', 'lmstudio', 'x'), ENTRIES), 'LM Studio');
});

test('a cloud provider keeps the generic error (null), and so does an unknown provider id', () => {
	assert.equal(unreachableLocalServerLabel(new ProviderError('network', 'groq', 'x'), ENTRIES), null);
	assert.equal(unreachableLocalServerLabel(new ProviderError('network', 'gone', 'x'), ENTRIES), null);
});

test('only network/timeout_connect count; other provider errors and non-provider errors are null', () => {
	assert.equal(unreachableLocalServerLabel(new ProviderError('auth', 'ollama', 'x'), ENTRIES), null);
	assert.equal(unreachableLocalServerLabel(new ProviderError('http_5xx', 'lmstudio', 'x'), ENTRIES), null);
	assert.equal(unreachableLocalServerLabel(new ProviderError('timeout_first_token', 'ollama', 'x'), ENTRIES), null);
	assert.equal(unreachableLocalServerLabel(new Error('boom'), ENTRIES), null);
});
