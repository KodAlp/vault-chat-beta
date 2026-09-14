import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatWithFallbackCore, type ChatFallbackDeps } from './chat-fallback';
import { ProviderError, type ChatRequest, type Chunk, type ProviderAdapter } from './types';
import type { ProviderConfigEntry } from './config-store';

function req(): ChatRequest {
	return { model: 'requested-model', messages: [{ role: 'user', content: 'hi' }] };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of gen) out.push(item);
	return out;
}

function okAdapter(id: string, texts: string[]): ProviderAdapter {
	return {
		id,
		async *chat(): AsyncGenerator<Chunk> {
			for (const t of texts) yield { type: 'text', text: t };
			yield { type: 'done' };
		},
		async listModels() {
			return [];
		},
		async health() {
			return 'ok';
		}
	};
}

/** Throws before yielding anything — the "failure before first token" case. */
function failingAdapter(id: string, err: unknown): ProviderAdapter {
	return {
		id,
		async *chat(): AsyncGenerator<Chunk> {
			throw err;
		},
		async listModels() {
			return [];
		},
		async health() {
			return 'ok';
		}
	};
}

/** Yields one text chunk, then throws — the "failure after first token" case. */
function failAfterTextAdapter(id: string, err: unknown): ProviderAdapter {
	return {
		id,
		async *chat(): AsyncGenerator<Chunk> {
			yield { type: 'text', text: 'partial' };
			throw err;
		},
		async listModels() {
			return [];
		},
		async health() {
			return 'ok';
		}
	};
}

/** A minimal but structurally valid entry, so a hop past index 0 resolves
 * to a real model (resolveHopModel(hopIndex>=1, entry, ...) reads only
 * entry.defaultModel) instead of being skipped for "no default model
 * configured" — the skipped-hop test below is the one place that
 * behavior is actually under test, and overrides this back to undefined. */
function stubEntry(id: string): ProviderConfigEntry {
	return {
		id,
		label: id,
		baseUrl: 'https://example.invalid',
		kind: 'openai-compat',
		reasoningDialect: 'none',
		enabled: true,
		timeouts: { connectMs: 1, firstTokenMs: 1, idleMs: 1 },
		defaultModel: `${id}-default-model`
	};
}

/** A default deps object with a 2-provider chain, everything enabled, and
 * every id resolving to a usable default model — override per test.
 * `notices` collects every logFallback call so tests can assert on which
 * fallbacks actually fired. */
function makeDeps(overrides: Partial<ChatFallbackDeps> = {}): ChatFallbackDeps & { notices: string[] } {
	const notices: string[] = [];
	return {
		notices,
		getChain: () => ['a', 'b'],
		isProviderEnabled: () => true,
		getProviderEntry: (id) => stubEntry(id),
		getAdapter: async () => {
			throw new Error('getAdapter not stubbed for this test');
		},
		logFallback: (message) => {
			notices.push(message);
		},
		...overrides
	};
}

test('a healthy first hop streams through untouched, with no fallback notices', async () => {
	const deps = makeDeps({
		getAdapter: async (id) => {
			if (id === 'a') return okAdapter('a', ['hello']);
			throw new Error('must not reach b — a succeeded');
		}
	});
	const events = await collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal));
	assert.deepEqual(events, [
		{ type: 'text', text: 'hello' },
		{ type: 'done' }
	]);
	assert.equal(deps.notices.length, 0);
});

test('a pin replaces the task chain entirely — the task default is never even consulted', async () => {
	const calls: string[] = [];
	const deps = makeDeps({
		getAdapter: async (id) => {
			calls.push(id);
			return okAdapter(id, ['x']);
		}
	});
	await collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal, 'b'));
	assert.deepEqual(calls, ['b']);
});

test('a pin is a constraint: a retryable failure from it throws immediately, never falling back to the task chain', async () => {
	const calls: string[] = [];
	const err = new ProviderError('network', 'z', 'boom');
	const deps = makeDeps({
		getChain: () => ['a'],
		getAdapter: async (id) => {
			calls.push(id);
			if (id === 'z') throw err;
			throw new Error('must not reach a — pin is a constraint, not a preference');
		}
	});
	await assert.rejects(
		collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal, 'z')),
		err
	);
	assert.deepEqual(calls, ['z']);
});

test('a pin to a disabled provider falls through to the base chain, with a notice', async () => {
	const calls: string[] = [];
	const deps = makeDeps({
		getChain: () => ['a'],
		isProviderEnabled: (id) => id !== 'z',
		getAdapter: async (id) => {
			calls.push(id);
			return okAdapter(id, ['ok']);
		}
	});
	await collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal, 'z'));
	assert.deepEqual(calls, ['a']);
	assert.match(deps.notices[0], /z devre dışı/);
});

test('a disabled provider never appears in the chain at all', async () => {
	const calls: string[] = [];
	const deps = makeDeps({
		isProviderEnabled: (id) => id !== 'a',
		getAdapter: async (id) => {
			calls.push(id);
			return okAdapter(id, ['ok']);
		}
	});
	await collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal));
	assert.deepEqual(calls, ['b']);
});

test('an all-disabled chain throws before any adapter is touched', async () => {
	const deps = makeDeps({
		getChain: () => [],
		getAdapter: async () => {
			throw new Error('must not be called — chain is empty');
		}
	});
	await assert.rejects(
		collect(chatWithFallbackCore(deps, 'quiz', req(), new AbortController().signal)),
		/etkin bir provider zinciri yok/
	);
});

test('a retryable failure before any text falls back to the next hop, with a notice', async () => {
	const deps = makeDeps({
		getAdapter: async (id) => {
			if (id === 'a') return failingAdapter('a', new ProviderError('timeout_connect', 'a', 'timed out'));
			return okAdapter('b', ['recovered']);
		}
	});
	const events = await collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal));
	assert.deepEqual(events, [
		{ type: 'notice', message: 'a kullanılamıyor (timeout_connect) → sıradaki modele geçiliyor' },
		{ type: 'text', text: 'recovered' },
		{ type: 'done' }
	]);
	assert.match(deps.notices[0], /a kullanılamıyor \(timeout_connect\)/);
});

test('a non-retryable error is thrown immediately, never falling back', async () => {
	const err = new ProviderError('auth', 'a', 'bad key');
	const deps = makeDeps({
		getAdapter: async (id) => {
			if (id === 'a') return failingAdapter('a', err);
			throw new Error('must not reach b — non-retryable must not fall back');
		}
	});
	await assert.rejects(collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal)), err);
	assert.equal(deps.notices.length, 0);
});

test('a retryable failure AFTER the first text chunk still throws, never splicing a second provider onto it', async () => {
	const deps = makeDeps({
		getAdapter: async (id) => {
			if (id === 'a') return failAfterTextAdapter('a', new ProviderError('http_5xx', 'a', 'died mid-stream'));
			throw new Error('must not reach b — must not splice after first token');
		}
	});
	const gen = chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal);
	const first = await gen.next();
	assert.deepEqual(first.value, { type: 'text', text: 'partial' });
	await assert.rejects(gen.next());
	assert.equal(deps.notices.length, 0);
});

test('a caller-initiated abort propagates as-is, without attempting the next hop', async () => {
	const controller = new AbortController();
	controller.abort();
	const deps = makeDeps({
		getAdapter: async (id) => {
			if (id === 'a') return failingAdapter('a', new Error('irrelevant — signal is already aborted'));
			throw new Error('must not reach b — an abort is never a fallback trigger');
		}
	});
	await assert.rejects(collect(chatWithFallbackCore(deps, 'chat', req(), controller.signal)));
	assert.equal(deps.notices.length, 0);
});

test('a chain ending in a skipped hop surfaces the earlier real error, not a generic "nothing worked"', async () => {
	const realErr = new ProviderError('http_5xx', 'a', 'a died');
	const deps = makeDeps({
		// Overrides makeDeps' usual stubEntry default: 'b' has no
		// defaultModel configured, so hop 1 resolves to null and is
		// skipped (resolveHopModel returns null for any non-zero hop with
		// no entry) — never reaching getAdapter for 'b' at all.
		getProviderEntry: () => undefined,
		getAdapter: async (id) => {
			if (id === 'a') return failingAdapter('a', realErr);
			throw new Error('must not be called — b has no defaultModel, must be skipped before getAdapter');
		}
	});
	await assert.rejects(collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal)), realErr);
});

test('getAdapter throwing for a deleted/unknown provider falls back instead of crashing the whole call', async () => {
	const deps = makeDeps({
		getAdapter: async (id) => {
			if (id === 'a') throw new Error('Bilinmeyen provider: a');
			return okAdapter('b', ['ok']);
		}
	});
	const events = await collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal));
	assert.deepEqual(events, [
		{ type: 'notice', message: 'a kullanılamıyor (error) → sıradaki modele geçiliyor' },
		{ type: 'text', text: 'ok' },
		{ type: 'done' }
	]);
	assert.match(deps.notices[0], /a kullanılamıyor/);
});

test('when every hop fails, the caller sees the LAST hop error', async () => {
	const errA = new ProviderError('network', 'a', 'a down');
	const errB = new ProviderError('network', 'b', 'b down');
	const deps = makeDeps({
		getAdapter: async (id) => (id === 'a' ? failingAdapter('a', errA) : failingAdapter('b', errB))
	});
	await assert.rejects(collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal)), errB);
});
