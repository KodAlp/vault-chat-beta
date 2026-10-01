import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBannerTarget, findLauncherId, type BannerProvider } from './localServerBanner';

const P = (over: Partial<BannerProvider> & { id: string }): BannerProvider => ({
	label: over.id,
	kind: 'openai-compat',
	enabled: true,
	local: false,
	baseUrl: 'https://example.invalid/v1',
	...over
});
const OLLAMA = P({ id: 'ollama', kind: 'ollama', local: true, baseUrl: 'http://127.0.0.1:11434' });
const LMS = P({ id: 'lmstudio', local: true, baseUrl: 'http://127.0.0.1:1234/v1' });
const CLOUD = P({ id: 'groq' });

test('empty chain and no pin: setup not finished', () => {
	assert.deepEqual(resolveBannerTarget({ pins: ['', ''], providers: [OLLAMA, CLOUD], chatChain: [] }), { state: 'setup' });
});

test('a chain whose providers are all disabled counts as setup not finished (CHAT_NO_CHAIN would be thrown)', () => {
	assert.deepEqual(resolveBannerTarget({ pins: [], providers: [{ ...OLLAMA, enabled: false }], chatChain: ['ollama'] }), { state: 'setup' });
});

test('chain head local: probe it', () => {
	assert.deepEqual(resolveBannerTarget({ pins: [], providers: [OLLAMA, CLOUD], chatChain: ['ollama', 'groq'] }), { state: 'local', provider: OLLAMA });
});

test('chain head is the first ENABLED chain member', () => {
	assert.deepEqual(resolveBannerTarget({ pins: [], providers: [{ ...CLOUD, enabled: false }, LMS], chatChain: ['groq', 'lmstudio'] }), { state: 'local', provider: LMS });
});

test('chain head cloud: no band', () => {
	assert.deepEqual(resolveBannerTarget({ pins: [], providers: [OLLAMA, CLOUD], chatChain: ['groq', 'ollama'] }), { state: 'none' });
});

test('an enabled pin wins over the chain; a pin naming a disabled/missing provider is ignored', () => {
	assert.deepEqual(resolveBannerTarget({ pins: ['lmstudio'], providers: [OLLAMA, LMS], chatChain: ['ollama'] }), { state: 'local', provider: LMS });
	assert.deepEqual(resolveBannerTarget({ pins: ['groq'], providers: [OLLAMA, { ...CLOUD, enabled: false }], chatChain: ['ollama'] }), { state: 'local', provider: OLLAMA });
	assert.deepEqual(resolveBannerTarget({ pins: ['gone'], providers: [OLLAMA], chatChain: ['ollama'] }), { state: 'local', provider: OLLAMA });
});

test('a cloud pin with an empty chain is fine (no setup band): the pin is a usable route', () => {
	assert.deepEqual(resolveBannerTarget({ pins: ['groq'], providers: [CLOUD], chatChain: [] }), { state: 'none' });
});

test('findLauncherId: ollama launcher for an Ollama provider, port match for others, else null', () => {
	const launchers = [{ id: 'ollama', port: 11434 }, { id: 'lmstudio', port: 1234 }];
	assert.equal(findLauncherId(OLLAMA, launchers), 'ollama');
	assert.equal(findLauncherId(LMS, launchers), 'lmstudio');
	assert.equal(findLauncherId(LMS, [{ id: 'ollama', port: 11434 }]), null);
	assert.equal(findLauncherId({ kind: 'openai-compat', baseUrl: 'not a url' }, launchers), null);
	assert.equal(findLauncherId(OLLAMA, [{ id: 'lmstudio', port: 1234 }]), null);
});
