import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMutex } from './jobMutex';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('run() keeps strict FIFO serialization', async () => {
	const m = createMutex();
	const log: string[] = [];
	const g1 = deferred();
	const p1 = m.run(async () => {
		log.push('1 start');
		await g1.promise;
		log.push('1 end');
	});
	const p2 = m.run(async () => {
		log.push('2 start');
	});
	await tick();
	assert.deepEqual(log, ['1 start']);
	g1.resolve();
	await Promise.all([p1, p2]);
	assert.deepEqual(log, ['1 start', '1 end', '2 start']);
});

test('run() propagates errors and the queue continues', async () => {
	const m = createMutex();
	const p1 = m.run(async () => {
		throw new Error('boom');
	});
	const p2 = m.run(async () => 'ok');
	await assert.rejects(p1, /boom/);
	assert.equal(await p2, 'ok');
});

test('a synchronously throwing task rejects instead of escaping', async () => {
	const m = createMutex();
	await assert.rejects(
		m.run((() => {
			throw new Error('sync');
		}) as () => Promise<void>),
		/sync/
	);
	assert.equal(await m.runShared(async () => 1, 2), 1);
});

test('runShared limit=1 is serial', async () => {
	const m = createMutex();
	let running = 0;
	let max = 0;
	const gates = [deferred(), deferred(), deferred()];
	const ps = gates.map((g) =>
		m.runShared(async () => {
			running++;
			max = Math.max(max, running);
			await g.promise;
			running--;
		}, 1)
	);
	await tick();
	assert.equal(running, 1);
	gates.forEach((g) => g.resolve());
	await Promise.all(ps);
	assert.equal(max, 1);
});

test('runShared limit=2 runs two at once, the third waits', async () => {
	const m = createMutex();
	const started: number[] = [];
	const gates = [deferred(), deferred(), deferred()];
	const ps = gates.map((g, i) =>
		m.runShared(async () => {
			started.push(i);
			await g.promise;
		}, 2)
	);
	await tick();
	assert.deepEqual(started, [0, 1]);
	gates[0].resolve();
	await tick();
	assert.deepEqual(started, [0, 1, 2]);
	gates[1].resolve();
	gates[2].resolve();
	await Promise.all(ps);
});

test('an exclusive job waits for running shared jobs', async () => {
	const m = createMutex();
	const log: string[] = [];
	const g = deferred();
	const s = m.runShared(async () => {
		log.push('shared start');
		await g.promise;
		log.push('shared end');
	}, 2);
	const e = m.run(async () => {
		log.push('excl');
	});
	await tick();
	assert.deepEqual(log, ['shared start']);
	g.resolve();
	await Promise.all([s, e]);
	assert.deepEqual(log, ['shared start', 'shared end', 'excl']);
});

test('a shared job queued behind a waiting exclusive does not jump it', async () => {
	const m = createMutex();
	const log: string[] = [];
	const g1 = deferred();
	const gE = deferred();
	const p1 = m.runShared(async () => {
		log.push('s1');
		await g1.promise;
	}, 3);
	const pe = m.run(async () => {
		log.push('e');
		await gE.promise;
	});
	const p2 = m.runShared(async () => {
		log.push('s2');
	}, 3);
	await tick();
	// The limit would allow s2, but the exclusive ahead of it is waiting.
	assert.deepEqual(log, ['s1']);
	g1.resolve();
	await tick();
	assert.deepEqual(log, ['s1', 'e']);
	gE.resolve();
	await Promise.all([p1, pe, p2]);
	assert.deepEqual(log, ['s1', 'e', 's2']);
});

test('a failing shared task frees its slot', async () => {
	const m = createMutex();
	const p1 = m.runShared(async () => {
		throw new Error('x');
	}, 1);
	const p2 = m.runShared(async () => 'next', 1);
	await assert.rejects(p1, /x/);
	assert.equal(await p2, 'next');
	assert.equal(await m.run(async () => 'excl'), 'excl');
});

test('mixed limits: each entry is checked against its own limit', async () => {
	const m = createMutex();
	const started: string[] = [];
	const ga = deferred();
	const gb = deferred();
	const gc = deferred();
	const pa = m.runShared(async () => {
		started.push('a');
		await ga.promise;
	}, 3);
	const pb = m.runShared(async () => {
		started.push('b');
		await gb.promise;
	}, 1);
	const pc = m.runShared(async () => {
		started.push('c');
		await gc.promise;
	}, 3);
	await tick();
	// b has limit 1 and a is running: b waits, and c (behind b) waits too.
	assert.deepEqual(started, ['a']);
	ga.resolve();
	await tick();
	// b starts alone (0 running < 1), then c is admitted next to it (1 < 3).
	assert.deepEqual(started, ['a', 'b', 'c']);
	gb.resolve();
	gc.resolve();
	await Promise.all([pa, pb, pc]);
});

test('limit is clamped to at least 1', async () => {
	const m = createMutex();
	assert.equal(await m.runShared(async () => 'ok', 0), 'ok');
	assert.equal(await m.runShared(async () => 'ok', Number.NaN), 'ok');
});
