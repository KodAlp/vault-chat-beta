import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatAdapter } from './openai-compat';
import { AzureOpenAIAdapter } from './azure-openai';
import type { ChatRequest } from './types';

const TIMEOUTS = { connectMs: 5000, firstTokenMs: 5000, idleMs: 5000 };

interface RecordedRequest {
	headers: http.IncomingHttpHeaders;
	body: { model?: string; [k: string]: unknown };
}

/**
 * A minimal in-process fake OpenAI-compatible server (node:http, port 0 — the OS picks a free port). /models
 * returns a couple of ids; /chat/completions records the last request's headers+body and streams back a
 * two-chunk SSE response, same shape a real OpenAI-compatible server sends. Used to verify, against a REAL
 * HTTP round trip rather than a stubbed fetch, that: OpenAICompatAdapter sends no Authorization header when
 * no key is configured (problem A — a local server with no key), AzureOpenAIAdapter sends `api-key` and
 * never `authorization` (problem D), and whatever `model` the caller passes (a pinned Azure deployment name,
 * problem B) is exactly what reaches the wire.
 */
function startFakeServer(): Promise<{ url: string; requests: RecordedRequest[]; close: () => Promise<void> }> {
	const requests: RecordedRequest[] = [];
	const server = http.createServer((req, res) => {
		if (req.method === 'GET' && req.url === '/models') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
			return;
		}
		if (req.method === 'POST' && req.url === '/chat/completions') {
			let raw = '';
			req.on('data', (chunk) => (raw += chunk));
			req.on('end', () => {
				let body: RecordedRequest['body'] = {};
				try {
					body = JSON.parse(raw);
				} catch {
					// leave body empty — a malformed request still gets recorded via headers
				}
				requests.push({ headers: req.headers, body });
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
				res.write('data: {"choices":[{"delta":{"content":" there"}}]}\n\n');
				res.write('data: [DONE]\n\n');
				res.end();
			});
			return;
		}
		res.writeHead(404);
		res.end();
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}`,
				requests,
				close: () => new Promise((r) => server.close(() => r()))
			});
		});
	});
}

const REQ: ChatRequest = { model: 'placeholder', messages: [{ role: 'user', content: 'hi' }] };

async function collectText(adapter: OpenAICompatAdapter, req: ChatRequest): Promise<string> {
	let text = '';
	for await (const chunk of adapter.chat(req, new AbortController().signal)) {
		if (chunk.type === 'text') text += chunk.text;
	}
	return text;
}

test('OpenAICompatAdapter without an apiKey sends no Authorization header', async () => {
	const fake = await startFakeServer();
	try {
		const adapter = new OpenAICompatAdapter({ id: 'local', baseUrl: fake.url, reasoningDialect: 'none', timeouts: TIMEOUTS });
		const text = await collectText(adapter, REQ);
		assert.equal(text, 'hi there');
		assert.equal(fake.requests.length, 1);
		assert.equal(fake.requests[0].headers.authorization, undefined);
	} finally {
		await fake.close();
	}
});

test('OpenAICompatAdapter with an apiKey sends a Bearer Authorization header', async () => {
	const fake = await startFakeServer();
	try {
		const adapter = new OpenAICompatAdapter({ id: 'cloud', baseUrl: fake.url, apiKey: 'sk-test-123', reasoningDialect: 'none', timeouts: TIMEOUTS });
		await collectText(adapter, REQ);
		assert.equal(fake.requests[0].headers.authorization, 'Bearer sk-test-123');
	} finally {
		await fake.close();
	}
});

test('AzureOpenAIAdapter sends api-key and never an Authorization header, even with a key configured', async () => {
	const fake = await startFakeServer();
	try {
		const adapter = new AzureOpenAIAdapter({ id: 'azure', baseUrl: fake.url, apiKey: 'azure-secret', reasoningDialect: 'none', timeouts: TIMEOUTS });
		const text = await collectText(adapter, { ...REQ, model: 'my-gpt4o-deployment' });
		assert.equal(text, 'hi there');
		assert.equal(fake.requests[0].headers['api-key'], 'azure-secret');
		assert.equal(fake.requests[0].headers.authorization, undefined);
	} finally {
		await fake.close();
	}
});

test('AzureOpenAIAdapter forwards a pinned deployment id as the request body\'s `model` field unchanged', async () => {
	const fake = await startFakeServer();
	try {
		const adapter = new AzureOpenAIAdapter({ id: 'azure', baseUrl: fake.url, apiKey: 'azure-secret', reasoningDialect: 'none', timeouts: TIMEOUTS });
		await collectText(adapter, { ...REQ, model: 'my-gpt4o-deployment' });
		assert.equal(fake.requests[0].body.model, 'my-gpt4o-deployment');
	} finally {
		await fake.close();
	}
});

test('AzureOpenAIAdapter without an apiKey sends neither api-key nor Authorization', async () => {
	const fake = await startFakeServer();
	try {
		const adapter = new AzureOpenAIAdapter({ id: 'azure', baseUrl: fake.url, reasoningDialect: 'none', timeouts: TIMEOUTS });
		await collectText(adapter, REQ);
		assert.equal(fake.requests[0].headers['api-key'], undefined);
		assert.equal(fake.requests[0].headers.authorization, undefined);
	} finally {
		await fake.close();
	}
});
