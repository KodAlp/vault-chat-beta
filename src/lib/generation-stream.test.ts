import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGenerationStream } from './generation-stream';

type Event = { type: string };

function sseResponse(lines: string[], init: ResponseInit = {}): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const enc = new TextEncoder();
			for (const l of lines) controller.enqueue(enc.encode(`data: ${l}\n\n`));
			controller.close();
		}
	});
	return new Response(body, { status: 200, ...init });
}

function withFetch(impl: typeof fetch, run: () => Promise<void>): Promise<void> {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	return run().finally(() => {
		globalThis.fetch = original;
	});
}

test('a stream ending with a done event is ok, and every event is delivered in order', () =>
	withFetch(
		async () => sseResponse(['{"type":"progress"}', '{"type":"done"}']),
		async () => {
			const seen: string[] = [];
			const result = await runGenerationStream<Event>('/x', {}, new AbortController(), (e) => seen.push(e.type));
			assert.deepEqual(result, { kind: 'ok' });
			assert.deepEqual(seen, ['progress', 'done']);
		}
	));

test('an error event also counts as a terminal event', () =>
	withFetch(
		async () => sseResponse(['{"type":"error","code":"GEN_QUIZ_EMPTY"}']),
		async () => {
			const result = await runGenerationStream<Event>('/x', {}, new AbortController(), () => {});
			assert.deepEqual(result, { kind: 'ok' });
		}
	));

test('a stream that closes without done or error is incomplete, not ok', () =>
	withFetch(
		async () => sseResponse(['{"type":"progress"}']),
		async () => {
			const result = await runGenerationStream<Event>('/x', {}, new AbortController(), () => {});
			assert.deepEqual(result, { kind: 'incomplete' });
		}
	));

test('a non-ok response is handed back for the caller to read', () =>
	withFetch(
		async () => new Response('{"code":"NOT_FOUND"}', { status: 404 }),
		async () => {
			const result = await runGenerationStream<Event>('/x', {}, new AbortController(), () => {});
			assert.equal(result.kind, 'bad-response');
		}
	));

test('aborting the caller-owned controller is reported as cancelled, never as an error', () =>
	withFetch(
		(_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
			}),
		async () => {
			const controller = new AbortController();
			const pending = runGenerationStream<Event>('/x', {}, controller, () => {});
			controller.abort();
			assert.deepEqual(await pending, { kind: 'cancelled' });
		}
	));

test('a network failure that is not our abort is a fetch-error', () =>
	withFetch(
		async () => {
			throw new TypeError('fetch failed');
		},
		async () => {
			const result = await runGenerationStream<Event>('/x', {}, new AbortController(), () => {});
			assert.equal(result.kind, 'fetch-error');
		}
	));
