import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerDisplayLabel } from './provider-label';

const t = (k: string) => (k === 'ProvidersSettingsPage.ollamaLocal' ? 'Ollama (local)' : k);

test('the stock Turkish Ollama label is localized, keyed off the provider id', () => {
	assert.equal(providerDisplayLabel('ollama', 'Ollama (yerel)', t), 'Ollama (local)');
});

test('user-defined or relabelled providers keep their stored label', () => {
	assert.equal(providerDisplayLabel('ollama', 'My GPU box', t), 'My GPU box');
	assert.equal(providerDisplayLabel('other', 'Ollama (yerel)', t), 'Ollama (yerel)');
	assert.equal(providerDisplayLabel('deepseek-api', 'DeepSeek', t), 'DeepSeek');
});
