import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithStartupWait, isLoopbackUrl } from './ollama-startup-wait';

const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

test('isLoopbackUrl', () => {
	assert.ok(isLoopbackUrl('http://127.0.0.1:11434/api/embed'));
	assert.ok(isLoopbackUrl('http://localhost:11434'));
	assert.ok(isLoopbackUrl('http://[::1]:11434'));
	assert.ok(!isLoopbackUrl('http://192.168.1.5:11434'));
	assert.ok(!isLoopbackUrl('nonsense'));
});

test('retries connection refusal on loopback until the server answers', async () => {
	let calls = 0;
	const res = await fetchWithStartupWait('http://127.0.0.1:11434/x', {}, {
		fetchFn: (async () => {
			if (++calls < 3) throw refused();
			return new Response('ok');
		}) as typeof fetch,
		sleep: async () => {}
	});
	assert.equal(calls, 3);
	assert.equal(await res.text(), 'ok');
});

test('gives up after the window', async () => {
	let t = 0;
	let calls = 0;
	await assert.rejects(
		fetchWithStartupWait('http://127.0.0.1:11434/x', {}, {
			fetchFn: (async () => { calls++; throw refused(); }) as typeof fetch,
			sleep: async (ms) => { t += ms; },
			now: () => t,
			waitMs: 3000
		})
	);
	assert.equal(calls, 4);
});

test('does not retry non-loopback hosts, HTTP errors or aborts', async () => {
	let calls = 0;
	await assert.rejects(
		fetchWithStartupWait('http://10.0.0.2:11434/x', {}, { fetchFn: (async () => { calls++; throw refused(); }) as typeof fetch, sleep: async () => {} })
	);
	assert.equal(calls, 1);
	calls = 0;
	const r = await fetchWithStartupWait('http://127.0.0.1:11434/x', {}, { fetchFn: (async () => { calls++; return new Response('', { status: 500 }); }) as typeof fetch });
	assert.equal(r.status, 500);
	assert.equal(calls, 1);
	calls = 0;
	await assert.rejects(
		fetchWithStartupWait('http://127.0.0.1:11434/x', {}, {
			fetchFn: (async () => { calls++; throw new DOMException('aborted', 'AbortError'); }) as typeof fetch,
			sleep: async () => {}
		})
	);
	assert.equal(calls, 1);
});
