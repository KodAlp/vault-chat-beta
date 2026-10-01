import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatWithFallbackCore, type ChatFallbackDeps } from './chat-fallback';
import { ProviderError, type ChatRequest, type Chunk, type ProviderAdapter } from './types';
import type { ProviderConfigEntry } from './config-store';
import { AppError } from '../app-error';

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
		isProviderConsented: () => true,
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

// İ2 (Aşama 8): consent is filtered exactly like the enabled toggle above —
// same three shapes (pin falls through, chain skips, all-filtered throws),
// proving a non-consented provider can never be reached even silently via
// chain fallback, not just when explicitly pinned.
test('a pin to a not-yet-consented provider falls through to the base chain, with a notice', async () => {
	const calls: string[] = [];
	const deps = makeDeps({
		getChain: () => ['a'],
		isProviderConsented: (id) => id !== 'z',
		getAdapter: async (id) => {
			calls.push(id);
			return okAdapter(id, ['ok']);
		}
	});
	await collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal, 'z'));
	assert.deepEqual(calls, ['a']);
	assert.match(deps.notices[0], /z henüz onaylanmadı/);
});

test('a not-yet-consented provider never appears in the chain at all', async () => {
	const calls: string[] = [];
	const deps = makeDeps({
		isProviderConsented: (id) => id !== 'a',
		getAdapter: async (id) => {
			calls.push(id);
			return okAdapter(id, ['ok']);
		}
	});
	await collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal));
	assert.deepEqual(calls, ['b']);
});

test('an all-not-consented chain throws before any adapter is touched', async () => {
	const deps = makeDeps({
		isProviderConsented: () => false,
		getAdapter: async () => {
			throw new Error('must not be called — nothing is consented');
		}
	});
	await assert.rejects(
		collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal)),
		(err: unknown) => err instanceof AppError && err.code === 'CHAT_NO_CHAIN' && err.params?.taskType === 'chat'
	);
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
		(err: unknown) => err instanceof AppError && err.code === 'CHAT_NO_CHAIN' && err.params?.taskType === 'quiz'
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
		{
			type: 'notice',
			message: 'a kullanılamıyor (timeout_connect) → sıradaki modele geçiliyor',
			code: 'CHAT_FALLBACK_UNAVAILABLE',
			params: { provider: 'a', kind: 'timeout_connect' }
		},
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
		{
			type: 'notice',
			message: 'a kullanılamıyor (error) → sıradaki modele geçiliyor',
			code: 'CHAT_FALLBACK_UNAVAILABLE',
			params: { provider: 'a', kind: 'error' }
		},
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

// ---------- continuation (resume from a clean prefix — see resume-plan.ts)

function continuationReq(): ChatRequest {
	return {
		model: 'requested-model',
		messages: [
			{ role: 'user', content: 'soru' },
			{ role: 'assistant', content: 'yarım cevap' }
		],
		continuation: true,
		stop: ['</think>']
	};
}

test('a continuation request never hops: a retryable failure surfaces so the caller restarts', async () => {
	const calls: string[] = [];
	const err = new ProviderError('timeout_connect', 'a', 'timed out');
	const deps = makeDeps({
		getAdapter: async (id) => {
			calls.push(id);
			if (id === 'a') return failingAdapter('a', err);
			throw new Error('must not reach b — b would read the partial answer as a finished turn');
		}
	});
	await assert.rejects(collect(chatWithFallbackCore(deps, 'chat', continuationReq(), new AbortController().signal)), err);
	assert.deepEqual(calls, ['a']);
	assert.equal(deps.notices.length, 0, 'no fallback notice — nothing was switched');
});

test('the same failure WITHOUT continuation still falls back (behaviour unchanged)', async () => {
	const calls: string[] = [];
	const deps = makeDeps({
		getAdapter: async (id) => {
			calls.push(id);
			if (id === 'a') return failingAdapter('a', new ProviderError('timeout_connect', 'a', 'timed out'));
			return okAdapter('b', ['recovered']);
		}
	});
	const events = await collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal));
	assert.deepEqual(calls, ['a', 'b']);
	assert.ok(events.some((e) => e.type === 'text' && e.text === 'recovered'));
});

test('a healthy continuation streams through untouched and the request reaches the adapter as sent', async () => {
	let seen: ChatRequest | undefined;
	const deps = makeDeps({
		getAdapter: async (id) => ({
			id,
			async *chat(r: ChatRequest): AsyncGenerator<Chunk> {
				seen = r;
				yield { type: 'text', text: ' devamı' };
				yield { type: 'done' };
			},
			async listModels() {
				return [];
			},
			async health() {
				return 'ok';
			}
		})
	});
	const events = await collect(chatWithFallbackCore(deps, 'chat', continuationReq(), new AbortController().signal));
	assert.deepEqual(events, [
		{ type: 'text', text: ' devamı' },
		{ type: 'done' }
	]);
	assert.equal(seen?.continuation, true);
	assert.deepEqual(seen?.stop, ['</think>']);
	assert.equal(seen?.messages.at(-1)?.role, 'assistant');
});

test('a non-retryable failure of a continuation is still thrown as-is', async () => {
	const err = new ProviderError('auth', 'a', 'bad key');
	const deps = makeDeps({ getAdapter: async (id) => failingAdapter(id, err) });
	await assert.rejects(collect(chatWithFallbackCore(deps, 'chat', continuationReq(), new AbortController().signal)), err);
});

// Aşama 4a — a dropped pin must not leak the pinned provider's model id into the chain head.
function modelRecordingAdapter(id: string, seen: string[]): ProviderAdapter {
	return {
		id,
		async *chat(r: ChatRequest): AsyncGenerator<Chunk> {
			seen.push(r.model);
			yield { type: 'text', text: 'ok' };
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

test('a dropped pin (disabled): hop 0 is asked for the chain head defaultModel, not the pinned provider req.model', async () => {
	const seen: string[] = [];
	const deps = makeDeps({
		getChain: () => ['a'],
		isProviderEnabled: (id) => id !== 'z',
		getAdapter: async (id) => modelRecordingAdapter(id, seen)
	});
	await collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal, 'z'));
	assert.deepEqual(seen, ['a-default-model']);
});

test('a dropped pin (not consented) behaves the same', async () => {
	const seen: string[] = [];
	const deps = makeDeps({
		getChain: () => ['a'],
		isProviderConsented: (id) => id !== 'z',
		getAdapter: async (id) => modelRecordingAdapter(id, seen)
	});
	await collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal, 'z'));
	assert.deepEqual(seen, ['a-default-model']);
});

test('a dropped pin whose chain head has no defaultModel skips that hop and moves on', async () => {
	const seen: string[] = [];
	const deps = makeDeps({
		isProviderEnabled: (id) => id !== 'z',
		getProviderEntry: (id) => (id === 'a' ? { ...stubEntry('a'), defaultModel: undefined } : stubEntry(id)),
		getAdapter: async (id) => modelRecordingAdapter(id, seen)
	});
	await collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal, 'z'));
	assert.deepEqual(seen, ['b-default-model']);
});

test('a valid pin still sends req.model unchanged to the pinned provider', async () => {
	const seen: string[] = [];
	const deps = makeDeps({ getAdapter: async (id) => modelRecordingAdapter(id, seen) });
	await collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal, 'b'));
	assert.deepEqual(seen, ['requested-model']);
});

test('no pin at all still sends req.model unchanged to the chain head', async () => {
	const seen: string[] = [];
	const deps = makeDeps({ getAdapter: async (id) => modelRecordingAdapter(id, seen) });
	await collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal));
	assert.deepEqual(seen, ['requested-model']);
});

// Aşama 4c — an empty req.model (fresh install: the client has no pick yet) means "the provider's own default".
test('an empty req.model: hop 0 asks the chain head for its defaultModel', async () => {
	const seen: string[] = [];
	const deps = makeDeps({ getChain: () => ['a'], getAdapter: async (id) => modelRecordingAdapter(id, seen) });
	await collect(chatWithFallbackCore(deps, 'chat', { ...req(), model: '' }, new AbortController().signal));
	assert.deepEqual(seen, ['a-default-model']);
});

test('an empty req.model with a valid pin: the pinned provider answers with its own defaultModel', async () => {
	const seen: string[] = [];
	const deps = makeDeps({ getAdapter: async (id) => modelRecordingAdapter(id, seen) });
	await collect(chatWithFallbackCore(deps, 'chat', { ...req(), model: '' }, new AbortController().signal, 'b'));
	assert.deepEqual(seen, ['b-default-model']);
});

test('an empty req.model and a chain head with no defaultModel: skipped, then CHAT_NO_MODEL_RESOLVED when nothing is left', async () => {
	const deps = makeDeps({
		getChain: () => ['a'],
		getProviderEntry: (id) => ({ ...stubEntry(id), defaultModel: undefined }),
		getAdapter: async (id) => okAdapter(id, ['x'])
	});
	await assert.rejects(
		collect(chatWithFallbackCore(deps, 'chat', { ...req(), model: '' }, new AbortController().signal)),
		(err: unknown) => err instanceof AppError && err.code === 'CHAT_NO_MODEL_RESOLVED'
	);
});

test('an empty chain throws CHAT_NO_CHAIN (the "setup not finished" state of a fresh install)', async () => {
	const deps = makeDeps({ getChain: () => [] });
	await assert.rejects(
		collect(chatWithFallbackCore(deps, 'chat', req(), new AbortController().signal)),
		(err: unknown) => err instanceof AppError && err.code === 'CHAT_NO_CHAIN'
	);
});
