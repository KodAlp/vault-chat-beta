import { AsyncLocalStorage } from 'node:async_hooks';
import { sharedJobMutex, type JobMutex } from '../jobMutex';
import { releaseConverterWorker } from '../convert-worker';
import { releaseReranker } from '../reranker';
import { getEmbeddingConfig, getOllamaBaseUrl } from './config-store';

export interface OllamaGate {
	/** Runs `fn` while holding a lease on `model` — for one-shot calls
	 * (embed()). Releases even if `fn` throws. */
	withModel<T>(model: string, fn: () => Promise<T>): Promise<T>;
	/** Same lease, but held for a whole generator's lifetime (a chat
	 * stream) — released once the generator is exhausted, returned early
	 * (caller stopped iterating), or thrown into. */
	withModelStream<T>(model: string, gen: () => AsyncGenerator<T>): AsyncGenerator<T>;
	/** GET /api/ps — what Ollama actually has resident right now. Exposed
	 * so callers (e.g. a future settings page) can show real state instead
	 * of this gate's ledger, which is a belief, not a fact. */
	reconcile(): Promise<Set<string>>;
	/** Frees VRAM for a job that must own the GPU (a docling conversion in a
	 * batch import): forgets the active model so every later lease on it
	 * queues behind the shared mutex, waits for leases already open on it to
	 * finish, then unloads every model Ollama reports resident that has no
	 * open lease. MUST be called while holding a `sharedJobMutex` slot
	 * (`run()` or `runShared()`) — it does not take the mutex itself (nesting
	 * would deadlock). A shared slot is enough: a model swap is exclusive
	 * (`mutex.run`) so it cannot start while any shared slot is held, and once
	 * `currentModel` is null every chat request for the old model misses the
	 * fast path and queues on that exclusive path. Several parallel
	 * conversions may call this concurrently; that is harmless (each just
	 * re-reads /api/ps and unloads whatever has no open lease, an idempotent
	 * keep_alive:0). */
	evictAllForExclusiveJob(): Promise<void>;
}

interface GateDeps {
	/** Best-effort — a failure must never break the caller whose lease
	 * triggered the swap. Matches the earlier OllamaAdapter.unload()'s
	 * contract, just relocated here since the gate is now the only caller. */
	unload(model: string): Promise<void>;
	reconcile(): Promise<Set<string>>;
}

const NATIVE_CALL_TIMEOUT_MS = 5000;

async function nativeUnload(model: string): Promise<void> {
	await fetch(`${getOllamaBaseUrl()}/api/chat`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model, messages: [], keep_alive: 0 }),
		signal: AbortSignal.timeout(NATIVE_CALL_TIMEOUT_MS)
	}).catch(() => {
		// best-effort — if Ollama's already down there's nothing to unload
	});
}

async function nativeReconcile(): Promise<Set<string>> {
	try {
		const res = await fetch(`${getOllamaBaseUrl()}/api/ps`, { signal: AbortSignal.timeout(NATIVE_CALL_TIMEOUT_MS) });
		if (!res.ok) return new Set();
		const data = (await res.json()) as { models?: { name: string }[] };
		return new Set((data.models ?? []).map((m) => m.name));
	} catch {
		// Unreachable Ollama isn't distinguishable from "nothing resident"
		// here, and the only caller (the swap path below) treats an empty
		// result as "can't confirm, so don't unload" — the conservative
		// side of the same failure either way.
		return new Set();
	}
}

/** Ollama's /api/ps reports `bge-m3:latest` for a model configured as
 * `bge-m3`; every name comparison in the gate goes through this so the two
 * spellings are one model. */
function normalizeModelName(model: string): string {
	return model.endsWith(':latest') ? model.slice(0, -':latest'.length) : model;
}

interface ModelState {
	refCount: number;
	drainWaiters: (() => void)[];
}

/**
 * Ref-counted lease over Ollama's RAM — every path that touches which
 * model(s) Ollama has loaded (chat, embed, title generation) goes through
 * this, replacing the old per-adapter `ensureModelLoaded()`/`currentModel`
 * pair that an audit found broken three ways:
 *
 *  1. The mutex only serialized the *swap decision*, not the generation
 *     itself — `unload(X)` could fire while a stream on X was still
 *     in-flight. Here, the lease spans the whole call/generator, and a
 *     swap can't even attempt to unload until every lease on the outgoing
 *     model has released (`waitForDrain`).
 *  2. The ledger (`currentModel`) was trusted blindly — a wrong "already
 *     loaded" belief is harmless (Ollama just reloads), but a wrong
 *     "I should unload this" belief isn't. `reconcile()` (native /api/ps)
 *     is consulted before every unload; if it doesn't confirm the model is
 *     actually resident, the unload is skipped.
 *  3. `embed()` bypassed the discipline entirely, undocumented. `residentModels`
 *     makes small always-loaded models (nomic-embed-text) a declared
 *     exception instead — they lease normally (so `reconcile()`/refcounts
 *     stay honest) but never wait on, and never trigger, a swap.
 *
 * Two callers requesting the *same* model run fully in parallel — the fast
 * path below never touches the mutex. Only a request for a *different*
 * model queues behind the shared job mutex (see jobMutex.ts — the same
 * queue the document conversion uses, so a conversion and a model swap
 * still never run concurrently either).
 */
export function createOllamaGate(
	deps: GateDeps = { unload: nativeUnload, reconcile: nativeReconcile },
	opts: { residentModels?: Iterable<string> | (() => Iterable<string>); mutex?: JobMutex } = {}
): OllamaGate {
	// A function, not a frozen Set, for the real singleton below: the
	// configured embedding model/provider can change at runtime (a settings
	// PUT to /api/embedding), and a Set captured once at process start would
	// go stale the moment it did — see the singleton's own doc comment.
	// Tests still pass a plain array literal, which this treats as a
	// constant iterable exactly like before.
	const residentSource = opts.residentModels ?? ['nomic-embed-text'];
	function isResident(model: string): boolean {
		const iterable = typeof residentSource === 'function' ? residentSource() : residentSource;
		const wanted = normalizeModelName(model);
		for (const m of iterable) if (normalizeModelName(m) === wanted) return true;
		return false;
	}
	// Non-resident models whose lease the current async context holds. Lets
	// acquire() refuse a nested lease on a *different* model: that request
	// would take the exclusive mutex and wait for the outer model to drain,
	// which it can never do because the requester itself is the one holding
	// it (and the stuck mutex would also block every conversion queued
	// behind it). Fails fast with an error instead of hanging silently.
	const heldModels = new AsyncLocalStorage<ReadonlySet<string>>();
	function withHeld<R>(model: string, run: () => R): R {
		return heldModels.run(new Set([...(heldModels.getStore() ?? []), model]), run);
	}
	const mutex = opts.mutex ?? sharedJobMutex;
	const states = new Map<string, ModelState>();
	let currentModel: string | null = null;

	function state(model: string): ModelState {
		let s = states.get(model);
		if (!s) {
			s = { refCount: 0, drainWaiters: [] };
			states.set(model, s);
		}
		return s;
	}

	function incRef(model: string): void {
		state(model).refCount++;
	}

	function decRef(model: string): void {
		const s = state(model);
		s.refCount = Math.max(0, s.refCount - 1);
		if (s.refCount === 0 && s.drainWaiters.length > 0) {
			const waiters = s.drainWaiters;
			s.drainWaiters = [];
			for (const resolve of waiters) resolve();
		}
	}

	function waitForDrain(model: string): Promise<void> {
		const s = state(model);
		if (s.refCount === 0) return Promise.resolve();
		return new Promise((resolve) => s.drainWaiters.push(resolve));
	}

	async function acquireNonResident(model: string): Promise<void> {
		// Fast path: joining the model that's already active never touches
		// the mutex, regardless of what else is queued behind it — this is
		// what lets two chats on the same model stream fully in parallel
		// instead of one waiting behind the other's queue position.
		if (currentModel === model) {
			incRef(model);
			return;
		}
		await mutex.run(async () => {
			// Re-check: another queued task may have already swapped to
			// `model` (or away from it) while this one waited for its turn.
			if (currentModel === model) {
				incRef(model);
				return;
			}
			// We hold the exclusive slot, so no conversion is running: stop the
			// idle converter worker (its docling models sit in the GPU memory
			// the chat model is about to load into). No-op when none exists.
			await releaseConverterWorker();
			// Same for the chat reranker (~1.2 GB): a model that loads while it is resident gets pushed partly onto the CPU.
			await releaseReranker();
			if (currentModel) {
				await waitForDrain(currentModel);
				const residentNow = await deps.reconcile();
				if ([...residentNow].some((m) => normalizeModelName(m) === currentModel)) await deps.unload(currentModel);
			}
			currentModel = model;
			incRef(model);
		});
	}

	/** `model` must already be normalized. Returns true when the lease is on
	 * a non-resident model (callers then record it via withHeld). */
	async function acquire(model: string): Promise<boolean> {
		if (isResident(model)) {
			incRef(model);
			return false;
		}
		const held = heldModels.getStore();
		if (held?.has(model)) {
			// Re-entrant join: this context's own open lease pins the model
			// (no swap can unload it before the lease drains), so skip the
			// mutex — it may be held by an evict job waiting on this very lease.
			incRef(model);
			return true;
		}
		if (held && held.size > 0) {
			const [other] = held;
			throw new Error(`ollama-gate: nested lease on "${model}" while holding "${other}" would deadlock`);
		}
		await acquireNonResident(model);
		return true;
	}

	return {
		async withModel<T>(rawModel: string, fn: () => Promise<T>): Promise<T> {
			const model = normalizeModelName(rawModel);
			const tracked = await acquire(model);
			try {
				return await (tracked ? withHeld(model, fn) : fn());
			} finally {
				decRef(model);
			}
		},
		async *withModelStream<T>(rawModel: string, gen: () => AsyncGenerator<T>): AsyncGenerator<T> {
			const model = normalizeModelName(rawModel);
			const tracked = await acquire(model);
			// An async generator body runs in the context of whoever calls
			// next(), not where it was created, so `yield*` would not carry
			// the held-model context into gen(). Drive it by hand and enter
			// the context for every step instead.
			const inScope = <R>(run: () => R): R => (tracked ? withHeld(model, run) : run());
			const inner = inScope(gen);
			try {
				while (true) {
					const r = await inScope(() => inner.next());
					if (r.done) return r.value;
					yield r.value;
				}
			} finally {
				// Early exit (consumer break/throw): let gen() run its own cleanup.
				await inScope(() => inner.return(undefined)).catch(() => {});
				decRef(model);
			}
		},
		reconcile: deps.reconcile,
		async evictAllForExclusiveJob(): Promise<void> {
			// Cleared before waiting, not after: from here on a request for
			// the old model misses acquireNonResident's fast path and queues
			// on the mutex this job's caller already holds.
			const prev = currentModel;
			currentModel = null;
			if (prev) await waitForDrain(prev);
			const residentNow = await deps.reconcile();
			for (const model of residentNow) {
				// A resident model (the embedder) can still hold a lease here —
				// it never queues on the mutex. Leave it loaded rather than
				// pull it out from under an in-flight call.
				if (state(normalizeModelName(model)).refCount === 0) await deps.unload(model);
			}
		}
	};
}

/** The one shared instance — mirrors jobMutex.ts's sharedJobMutex singleton.
 * residentModels is a function, not a fixed array, so this always reflects
 * WHATEVER model is currently configured for embedding (getEmbeddingConfig(),
 * providers/config-store.ts) rather than a name frozen at process start —
 * before embedding-provider independence this was the EMBED_MODEL constant, which meant a user who
 * changed the embedding model at runtime would silently lose the
 * never-swaps exception for the new model (and keep it, wrongly, for the
 * old one) until the process restarted. A provider that isn't 'ollama' has
 * no Ollama model to keep resident, so this only ever matters when it is. */
export const ollamaGate: OllamaGate = createOllamaGate(undefined, {
	// FTS-only mode (null config) has no embedding model to keep resident.
	residentModels: () => {
		const cfg = getEmbeddingConfig();
		return cfg ? [cfg.model] : [];
	}
});
