import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stalePinPatch, type PinFields } from './settings-reconcile';

const PINS: PinFields = {
	defaultModel: 'qwen3:8b',
	fastModel: 'deepseek-chat',
	reasoningModel: '',
	defaultProvider: 'ollama',
	fastProvider: 'deepseek-api',
	reasoningProvider: ''
};

test('a pin whose provider is gone (deleted or disabled) is cleared together with its model', () => {
	const patch = stalePinPatch(PINS, new Set(['ollama']));
	assert.deepEqual(patch, { fastProvider: '', fastModel: '' });
});

test('pins whose providers are all usable, and blank pins, produce no patch', () => {
	assert.deepEqual(stalePinPatch(PINS, new Set(['ollama', 'deepseek-api'])), {});
	assert.deepEqual(stalePinPatch({ ...PINS, defaultProvider: '', defaultModel: '', fastProvider: '', fastModel: '' }, new Set()), {});
});

test('with no usable provider at all every non-blank pin is cleared', () => {
	assert.deepEqual(stalePinPatch(PINS, new Set()), {
		defaultProvider: '',
		defaultModel: '',
		fastProvider: '',
		fastModel: ''
	});
});
