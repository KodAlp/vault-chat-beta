import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogIdForPort, portFromBaseUrl, catalogIdForBaseUrl } from './localServerMatch';

test('catalogIdForPort matches each known default port', () => {
	assert.equal(catalogIdForPort(11434), 'ollama');
	assert.equal(catalogIdForPort(1234), 'lmstudio');
	assert.equal(catalogIdForPort(8081), 'llamacpp-embed');
	assert.equal(catalogIdForPort(1337), 'jan');
	assert.equal(catalogIdForPort(8000), 'vllm');
});

test('catalogIdForPort resolves the 8080 collision to llamacpp, not localai', () => {
	assert.equal(catalogIdForPort(8080), 'llamacpp');
});

test('catalogIdForPort returns undefined for an unknown port', () => {
	assert.equal(catalogIdForPort(9999), undefined);
});

test('portFromBaseUrl extracts an explicit port', () => {
	assert.equal(portFromBaseUrl('http://127.0.0.1:1234/v1'), 1234);
	assert.equal(portFromBaseUrl('http://127.0.0.1:11434'), 11434);
});

test('portFromBaseUrl returns undefined with no explicit port or on garbage input', () => {
	assert.equal(portFromBaseUrl('https://api.deepseek.com/v1'), undefined);
	assert.equal(portFromBaseUrl('not a url'), undefined);
	assert.equal(portFromBaseUrl(''), undefined);
});

test('catalogIdForBaseUrl composes both steps', () => {
	assert.equal(catalogIdForBaseUrl('http://127.0.0.1:1234/v1'), 'lmstudio');
	assert.equal(catalogIdForBaseUrl('https://api.deepseek.com/v1'), undefined);
});
