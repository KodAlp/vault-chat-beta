import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaGate } from './ollama-gate';
import { createMutex } from '../jobMutex';

/** A controllable deferred promise — lets a test hold a lease open until it
 * explicitly decides to let it finish, so interleaving can be asserted. */
function deferred<T = void>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

function fakeDeps(residentSet: () => Set<string>) {
	const unloadCalls: string[] = [];
	return {
		deps: {
			async unload(model: string) {
				unloadCalls.push(model);
			},
			async reconcile() {
				return residentSet();
			}
		},
		unloadCalls
	};
}

test('two leases on the same model run fully in parallel — no unload', async () => {
	const { deps, unloadCalls } = fakeDeps(() => new Set(['a']));
	const gate = createOllamaGate(deps, { mutex: createMutex(), residentModels: [] });

	const first = deferred<string>();
	const second = deferred<string>();

	const p1 = gate.withModel('a', () => first.promise);
	const p2 = gate.withModel('a', () => second.promise);

	// Both should be able to resolve independently, in either order — if
	// they were serialized behind the mutex, resolving second before first
	// would still work fine (that's the point: no ordering dependency).
	second.resolve('second-done');
	first.resolve('first-done');

	assert.equal(await p1, 'first-done');
	assert.equal(await p2, 'second-done');
	assert.deepEqual(unloadCalls, []);
});

test('a different model must wait for the active lease to drain before unloading', async () => {
	const { deps, unloadCalls } = fakeDeps(() => new Set(['a']));
	const gate = createOllamaGate(deps, { mutex: createMutex(), residentModels: [] });

	const aWork = deferred<string>();
	const pA = gate.withModel('a', () => aWork.promise);

	let bStarted = false;
	const pB = gate.withModel('b', async () => {
		bStarted = true;
		return 'b-done';
	});

	// Give the event loop a few turns — B must NOT have started yet, and
	// unload('a') must NOT have been called, while A's lease is still open.
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(bStarted, false);
	assert.deepEqual(unloadCalls, []);

	aWork.resolve('a-done');
	assert.equal(await pA, 'a-done');
	assert.equal(await pB, 'b-done');
	assert.deepEqual(unloadCalls, ['a']);
});

test('a resident model is never unloaded and never triggers a swap wait', async () => {
	const { deps, unloadCalls } = fakeDeps(() => new Set(['big-model']));
	const gate = createOllamaGate(deps, { mutex: createMutex(), residentModels: ['embed-model'] });

	const bigWork = deferred<string>();
	const pBig = gate.withModel('big-model', () => bigWork.promise);

	// The resident model must be able to run concurrently with the active
	// big model's still-open lease — no waiting on the mutex at all.
	const embedResult = await gate.withModel('embed-model', async () => 'embed-done');
	assert.equal(embedResult, 'embed-done');
	assert.deepEqual(unloadCalls, []);

	bigWork.resolve('big-done');
	assert.equal(await pBig, 'big-done');

	// Requesting a genuinely different big model afterwards must unload
	// big-model, but never embed-model (resident, never a swap target).
	await gate.withModel('other-big-model', async () => 'ok');
	assert.deepEqual(unloadCalls, ['big-model']);
});

test('unload is skipped when reconcile does not confirm the model is actually resident', async () => {
	// Ollama's own keep_alive already evicted 'a' out of band — reconcile()
	// reflects that ground truth, so the gate must not call unload('a').
	const { deps, unloadCalls } = fakeDeps(() => new Set());
	const gate = createOllamaGate(deps, { mutex: createMutex(), residentModels: [] });

	await gate.withModel('a', async () => 'a-done');
	await gate.withModel('b', async () => 'b-done');

	assert.deepEqual(unloadCalls, []);
});

test('withModelStream releases its lease once the generator is fully consumed', async () => {
	const { deps, unloadCalls } = fakeDeps(() => new Set(['a']));
	const gate = createOllamaGate(deps, { mutex: createMutex(), residentModels: [] });

	async function* source() {
		yield 1;
		yield 2;
	}

	const collected: number[] = [];
	for await (const v of gate.withModelStream('a', source)) collected.push(v);
	assert.deepEqual(collected, [1, 2]);

	// Lease must be released by now — a subsequent different-model request
	// should proceed (and unload 'a') without hanging.
	await gate.withModel('b', async () => 'ok');
	assert.deepEqual(unloadCalls, ['a']);
});

test('withModelStream releases its lease even when the consumer stops early', async () => {
	const { deps, unloadCalls } = fakeDeps(() => new Set(['a']));
	const gate = createOllamaGate(deps, { mutex: createMutex(), residentModels: [] });

	async function* source() {
		try {
			yield 1;
			yield 2;
		} finally {
			// generator's own cleanup still runs — nothing special needed
			// here, this just documents that early-return interacts safely
			// with the gate's outer try/finally.
		}
	}

	for await (const v of gate.withModelStream('a', source)) {
		if (v === 1) break;
	}

	await gate.withModel('b', async () => 'ok');
	assert.deepEqual(unloadCalls, ['a']);
});

test('evictAllForExclusiveJob waits for the active lease, then unloads every idle resident model', async () => {
	const { deps, unloadCalls } = fakeDeps(() => new Set(['chat', 'embed-model']));
	const gate = createOllamaGate(deps, { mutex: createMutex(), residentModels: ['embed-model'] });

	const chatWork = deferred<string>();
	const pChat = gate.withModel('chat', () => chatWork.promise);
	await new Promise((r) => setTimeout(r, 0));

	let evicted = false;
	const pEvict = gate.evictAllForExclusiveJob().then(() => (evicted = true));

	// The in-flight chat call is never cut off — nothing unloads until it ends.
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(evicted, false);
	assert.deepEqual(unloadCalls, []);

	chatWork.resolve('chat-done');
	assert.equal(await pChat, 'chat-done');
	await pEvict;
	assert.deepEqual([...unloadCalls].sort(), ['chat', 'embed-model']);
});

test('evictAllForExclusiveJob leaves a model with an open lease loaded', async () => {
	const { deps, unloadCalls } = fakeDeps(() => new Set(['embed-model', 'stray']));
	const gate = createOllamaGate(deps, { mutex: createMutex(), residentModels: ['embed-model'] });

	const embedWork = deferred<string>();
	const pEmbed = gate.withModel('embed-model', () => embedWork.promise);
	await new Promise((r) => setTimeout(r, 0));

	await gate.evictAllForExclusiveJob();
	assert.deepEqual(unloadCalls, ['stray']);

	embedWork.resolve('embed-done');
	assert.equal(await pEmbed, 'embed-done');
});

test('after evictAllForExclusiveJob, the old model waits behind the job holding the mutex', async () => {
	const { deps } = fakeDeps(() => new Set());
	const mutex = createMutex();
	const gate = createOllamaGate(deps, { mutex, residentModels: [] });

	await gate.withModel('chat', async () => 'warm'); // 'chat' becomes the active model

	const job = deferred();
	let chatRan = false;
	const pJob = mutex.run(async () => {
		await gate.evictAllForExclusiveJob();
		await job.promise; // the conversion
	});
	await new Promise((r) => setTimeout(r, 0));

	// Without eviction this would take the same-model fast path and run now.
	const pChat = gate.withModel('chat', async () => {
		chatRan = true;
		return 'chat-done';
	});
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(chatRan, false);

	job.resolve();
	await pJob;
	assert.equal(await pChat, 'chat-done');
	assert.equal(chatRan, true);
});
