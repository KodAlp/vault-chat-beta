import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelCaps, supportsPrefixResume } from './registry';
import type { ProvidersFile } from './config-store';

const T = { connectMs: 1, firstTokenMs: 1, idleMs: 1 };

function useProviders(): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-caps-test-'));
	const data: ProvidersFile = {
		providers: [
			{ id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434', kind: 'ollama', reasoningDialect: 'reasoning_content', enabled: true, timeouts: T },
			{ id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', kind: 'openai-compat', reasoningDialect: 'reasoning_content', enabled: true, local: true, timeouts: T, modelCaps: { 'my-model': { tools: true }, 'qwen/qwen3-8b': { tools: false } } },
			{ id: 'claude', label: 'Claude', baseUrl: 'https://api.anthropic.com/v1', kind: 'anthropic', reasoningDialect: 'none', enabled: true, timeouts: T }
		],
		chains: { chat: ['ollama'] }
	};
	fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify(data), 'utf-8');
	process.env.PROVIDERS_PATH = path.join(dir, 'providers.json');
}

test('modelCaps is table-driven for every provider kind, not Ollama-only', async () => {
	useProviders();
	assert.deepEqual(await modelCaps('ollama', 'qwen3:8b'), { tools: true, reasoning: true });
	assert.deepEqual(await modelCaps('lmstudio', 'Qwen3-8B-Q4_K_M.gguf'), { tools: true, reasoning: true });
	assert.deepEqual(await modelCaps('lmstudio', 'llama-3.2-3b'), { tools: false, reasoning: false });
	assert.deepEqual(await modelCaps('claude', 'claude-sonnet'), { tools: false, reasoning: false });
});

test('modelCaps applies the entry override (wins over the table) and fails closed for unknown providers', async () => {
	useProviders();
	assert.deepEqual(await modelCaps('lmstudio', 'qwen/qwen3-8b'), { tools: false, reasoning: true });
	assert.deepEqual(await modelCaps('lmstudio', 'my-model'), { tools: true, reasoning: false });
	assert.deepEqual(await modelCaps('no-such', 'qwen3:8b'), { tools: false, reasoning: false });
});

test('supportsPrefixResume stays Ollama-only: a verified family on a non-Ollama provider is still false', async () => {
	useProviders();
	assert.equal(await supportsPrefixResume('ollama', 'qwen3:8b'), true);
	assert.equal(await supportsPrefixResume('lmstudio', 'qwen/qwen3-8b'), false);
});
