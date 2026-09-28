import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { embedTexts, measureEmbeddingDims, embeddingKey } from './embeddings';
import { setEmbeddingConfig, type ProvidersFile } from './providers/config-store';
import { grantProviderConsent, revokeProviderConsent } from './provider-consent';
import { secretStore } from './providers/secrets';
import { AppError } from './app-error';
import { EMBED_MODEL, EMBED_DIMS } from './embed-config';

const OLLAMA: ProvidersFile['providers'][number] = {
	id: 'ollama',
	label: 'Ollama',
	baseUrl: 'http://127.0.0.1:11434/v1',
	kind: 'ollama',
	reasoningDialect: 'think-tags',
	enabled: true,
	timeouts: { connectMs: 5000, firstTokenMs: 120000, idleMs: 30000 }
};

function cloudCompat(id: string, overrides: Partial<ProvidersFile['providers'][number]> = {}): ProvidersFile['providers'][number] {
	return {
		id,
		label: id,
		baseUrl: `https://api.${id}.example/v1`,
		kind: 'openai-compat',
		reasoningDialect: 'none',
		enabled: true,
		timeouts: { connectMs: 5000, firstTokenMs: 30000, idleMs: 30000 },
		...overrides
	};
}

/** Fresh PROVIDERS_PATH/SECRETS_PATH/PROVIDER_CONSENT_PATH per test — same
 * isolation shape as config-store.test.ts's useTmpProvidersFile, extended to
 * the two other files embeddings.ts reads through (secrets.ts, provider-
 * consent.ts). */
function useTmpEnv(providers: ProvidersFile['providers']): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embeddings-test-'));
	const providersFile: ProvidersFile = { providers, chains: { chat: [providers[0]?.id ?? 'ollama'] } };
	fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify(providersFile, null, 2), 'utf-8');
	process.env.PROVIDERS_PATH = path.join(dir, 'providers.json');
	process.env.SECRETS_PATH = path.join(dir, 'secrets.json');
	process.env.PROVIDER_CONSENT_PATH = path.join(dir, 'provider-consent.json');
}

function fakeFetch(handler: (url: string, init: RequestInit | undefined) => Response) {
	const seen: { url: string; init: RequestInit | undefined }[] = [];
	const real = globalThis.fetch;
	globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
		seen.push({ url: String(url), init });
		return handler(String(url), init);
	}) as typeof fetch;
	return { seen, restore: () => (globalThis.fetch = real) };
}

function embedResponse(vector: number[], status = 200): Response {
	return new Response(JSON.stringify({ embeddings: [vector] }), { status });
}

function openAIEmbedResponse(vectors: number[][], status = 200): Response {
	return new Response(JSON.stringify({ data: vectors.map((embedding, index) => ({ embedding, index })) }), { status });
}

// --- Ollama path ---

test('embedTexts (ollama) posts to /api/embed with cpuOnly for a query', async () => {
	useTmpEnv([OLLAMA]);
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 3 });
	const { seen, restore } = fakeFetch(() => embedResponse([0.1, 0.2, 0.3]));
	try {
		const out = await embedTexts(['merhaba'], { purpose: 'query' });
		assert.deepEqual(out, [[0.1, 0.2, 0.3]]);
		assert.match(seen[0].url, /\/api\/embed$/);
		const body = JSON.parse(String(seen[0].init?.body));
		assert.deepEqual(body, { model: 'bge-m3', input: ['merhaba'], options: { num_gpu: 0 } });
	} finally {
		restore();
	}
});

test('embedTexts (ollama) does not set cpuOnly for a document', async () => {
	useTmpEnv([OLLAMA]);
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 3 });
	const { seen, restore } = fakeFetch(() => embedResponse([0.1, 0.2, 0.3]));
	try {
		await embedTexts(['bir paragraf'], { purpose: 'document' });
		const body = JSON.parse(String(seen[0].init?.body));
		assert.equal('options' in body, false);
	} finally {
		restore();
	}
});

test('embedTexts (ollama) throws EMBEDDING_UNAVAILABLE on a non-OK response', async () => {
	useTmpEnv([OLLAMA]);
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 3 });
	const { restore } = fakeFetch(() => new Response('boom', { status: 500 }));
	try {
		await assert.rejects(
			() => embedTexts(['x'], { purpose: 'query' }),
			(err: unknown) => {
				assert.ok(err instanceof AppError);
				assert.equal(err.code, 'EMBEDDING_UNAVAILABLE');
				return true;
			}
		);
	} finally {
		restore();
	}
});

test('embedTexts (ollama) throws EMBEDDING_UNAVAILABLE when fetch itself throws', async () => {
	useTmpEnv([OLLAMA]);
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 3 });
	const real = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw new Error('ECONNREFUSED');
	}) as typeof fetch;
	try {
		await assert.rejects(
			() => embedTexts(['x'], { purpose: 'query' }),
			(err: unknown) => err instanceof AppError && err.code === 'EMBEDDING_UNAVAILABLE'
		);
	} finally {
		globalThis.fetch = real;
	}
});

test('embedTexts throws EMBEDDING_DIMS_MISMATCH when the provider returns the wrong length', async () => {
	useTmpEnv([OLLAMA]);
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 1024 });
	const { restore } = fakeFetch(() => embedResponse([0.1, 0.2, 0.3])); // only 3 dims, config says 1024
	try {
		await assert.rejects(
			() => embedTexts(['x'], { purpose: 'query' }),
			(err: unknown) => {
				assert.ok(err instanceof AppError);
				assert.equal(err.code, 'EMBEDDING_DIMS_MISMATCH');
				return true;
			}
		);
	} finally {
		restore();
	}
});

test('embedTexts batches documents in groups of 32', async () => {
	useTmpEnv([OLLAMA]);
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 1 });
	const { seen, restore } = fakeFetch((_url, init) => {
		const input = JSON.parse(String(init?.body)).input as string[];
		return new Response(JSON.stringify({ embeddings: input.map(() => [0.1]) }), { status: 200 });
	});
	try {
		const texts = Array.from({ length: 65 }, (_, i) => `t${i}`);
		const out = await embedTexts(texts, { purpose: 'document' });
		assert.equal(out.length, 65);
		assert.equal(seen.length, 3); // 32 + 32 + 1
		assert.equal(JSON.parse(String(seen[0].init?.body)).input.length, 32);
		assert.equal(JSON.parse(String(seen[2].init?.body)).input.length, 1);
	} finally {
		restore();
	}
});

test('embedTexts returns [] immediately for an empty input, no network call', async () => {
	useTmpEnv([OLLAMA]);
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 3 });
	const { seen, restore } = fakeFetch(() => embedResponse([0.1, 0.2, 0.3]));
	try {
		assert.deepEqual(await embedTexts([], { purpose: 'query' }), []);
		assert.equal(seen.length, 0);
	} finally {
		restore();
	}
});

// --- openai-compat path (local or cloud) ---

test('embedTexts (openai-compat, local) posts {model, input} with no auth header when there is no key', async () => {
	const local = cloudCompat('lmstudio', { local: true });
	useTmpEnv([OLLAMA, local]);
	setEmbeddingConfig({ providerId: 'lmstudio', model: 'nomic-embed-text-v1.5', dims: 2 });
	const { seen, restore } = fakeFetch(() => openAIEmbedResponse([[1, 2]]));
	try {
		const out = await embedTexts(['hello'], { purpose: 'query' });
		assert.deepEqual(out, [[1, 2]]);
		assert.equal(seen[0].url, 'https://api.lmstudio.example/v1/embeddings');
		const body = JSON.parse(String(seen[0].init?.body));
		assert.deepEqual(body, { model: 'nomic-embed-text-v1.5', input: ['hello'] });
		const headers = seen[0].init?.headers as Record<string, string>;
		assert.equal('authorization' in headers, false);
	} finally {
		restore();
	}
});

test('embedTexts (openai-compat, cloud) sends a Bearer auth header from secretStore', async () => {
	const cloud = cloudCompat('deepseek');
	useTmpEnv([OLLAMA, cloud]);
	grantProviderConsent('deepseek');
	await secretStore.set('deepseek', 'sk-testkey123');
	setEmbeddingConfig({ providerId: 'deepseek', model: 'embed-1', dims: 2 });
	const { seen, restore } = fakeFetch(() => openAIEmbedResponse([[1, 2]]));
	try {
		await embedTexts(['hello'], { purpose: 'query' });
		const headers = seen[0].init?.headers as Record<string, string>;
		assert.equal(headers.authorization, 'Bearer sk-testkey123');
	} finally {
		restore();
	}
});

test('embedTexts (openai-compat) sorts the response by index before returning', async () => {
	const local = cloudCompat('lmstudio', { local: true });
	useTmpEnv([OLLAMA, local]);
	setEmbeddingConfig({ providerId: 'lmstudio', model: 'm', dims: 1 });
	const { restore } = fakeFetch(() => new Response(JSON.stringify({ data: [{ embedding: [2], index: 1 }, { embedding: [1], index: 0 }] }), { status: 200 }));
	try {
		const out = await embedTexts(['a', 'b'], { purpose: 'document' });
		assert.deepEqual(out, [[1], [2]]);
	} finally {
		restore();
	}
});

test('embedTexts on a cloud openai-compat provider with no consent throws EMBEDDING_CONSENT_REQUIRED, before any network call', async () => {
	const cloud = cloudCompat('deepseek');
	useTmpEnv([OLLAMA, cloud]);
	// setEmbeddingConfig() enforces consent at save time too, so to exercise
	// embedTexts()'s OWN runtime check we save the config first (with consent),
	// then revoke it before calling embedTexts — simulating a config saved
	// under consent that was later withdrawn.
	grantProviderConsent('deepseek');
	setEmbeddingConfig({ providerId: 'deepseek', model: 'embed-1', dims: 2 });
	revokeProviderConsent('deepseek');
	const { seen, restore } = fakeFetch(() => openAIEmbedResponse([[1, 2]]));
	try {
		await assert.rejects(
			() => embedTexts(['x'], { purpose: 'query' }),
			(err: unknown) => err instanceof AppError && err.code === 'EMBEDDING_CONSENT_REQUIRED'
		);
		assert.equal(seen.length, 0);
	} finally {
		restore();
	}
});

// --- measureEmbeddingDims ---

test('measureEmbeddingDims returns the vector length from one real embed call', async () => {
	useTmpEnv([OLLAMA]);
	const { restore } = fakeFetch(() => embedResponse([0.1, 0.2, 0.3, 0.4]));
	try {
		assert.equal(await measureEmbeddingDims('ollama', 'bge-m3'), 4);
	} finally {
		restore();
	}
});

test('measureEmbeddingDims never validates against the saved embedding config\'s dims', async () => {
	useTmpEnv([OLLAMA]);
	// Saved config says 999 dims for this exact model — measureEmbeddingDims must
	// still report the REAL measured length (2), not throw or coerce to 999: it
	// is a probe for what a config SHOULD be, not a check against what it is.
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 999 });
	const { restore } = fakeFetch(() => embedResponse([1, 2]));
	try {
		assert.equal(await measureEmbeddingDims('ollama', 'bge-m3'), 2);
	} finally {
		restore();
	}
});

// --- embeddingKey() ---

test('embeddingKey returns the legacy EMBED_MODEL constant for the default ollama/bge-m3 config', () => {
	assert.equal(embeddingKey({ providerId: 'ollama', model: EMBED_MODEL, dims: EMBED_DIMS }), EMBED_MODEL);
});

test('embeddingKey returns a provider/model/dims identity for any non-default config', () => {
	assert.equal(embeddingKey({ providerId: 'deepseek', model: 'embed-1', dims: 768 }), 'deepseek/embed-1/768');
	assert.equal(embeddingKey({ providerId: 'ollama', model: 'other-model', dims: EMBED_DIMS }), 'ollama/other-model/1024');
});
