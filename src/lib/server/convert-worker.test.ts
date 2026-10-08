import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
	appendTail,
	applyEvent,
	classifyEnd,
	classifyExit,
	createConvertWorker,
	newJobProgress,
	parseWorkerLine,
	releaseConverterWorker,
	setSharedConvertWorker,
	type ConvertWorker,
	type WorkerChild,
	type WorkerOutcome
} from './convert-worker';
import { AppError } from './app-error';
import { PROCESS_TIMEOUT_MS, pdfTimeoutMs } from './convert-timeouts';
import type { ConvertEvent } from './convertQueue';

// ---- pure logic ----------------------------------------------------------

test('parseWorkerLine: keeps only JSON objects with a string id and type', () => {
	assert.deepEqual(parseWorkerLine('{"type":"progress","stage":"converting","id":"7"}'), {
		type: 'progress',
		stage: 'converting',
		id: '7'
	});
	assert.equal(parseWorkerLine(''), null);
	assert.equal(parseWorkerLine('   '), null);
	assert.equal(parseWorkerLine('Loading model...'), null);
	assert.equal(parseWorkerLine('{"type":"progress"}'), null); // no id
	assert.equal(parseWorkerLine('{"id":7,"type":"progress"}'), null); // id not a string
	assert.equal(parseWorkerLine('{"id":"1"}'), null); // no type
	assert.equal(parseWorkerLine('[1,2]'), null);
	assert.equal(parseWorkerLine('null'), null);
});

test('applyEvent: the pageCount event swaps the floor for a page-aware timeout and adds an estimate', () => {
	const p = newJobProgress();
	assert.equal(p.timeoutMs, PROCESS_TIMEOUT_MS);
	const noPages: ConvertEvent = { type: 'progress', stage: 'converting' };
	assert.equal(applyEvent(p, noPages), null);
	assert.equal(p.timeoutMs, PROCESS_TIMEOUT_MS);
	// pageCount 0 = pdf_page_count() failed: the floor stays.
	assert.equal(applyEvent(p, { type: 'progress', stage: 'converting', pageCount: 0 }), null);
	assert.equal(p.timeoutMs, PROCESS_TIMEOUT_MS);
	const withPages: ConvertEvent = { type: 'progress', stage: 'converting', pageCount: 10 };
	assert.equal(applyEvent(p, withPages), pdfTimeoutMs(10));
	assert.equal(p.timeoutMs, pdfTimeoutMs(10));
	assert.equal((withPages as { estimatedSeconds?: number }).estimatedSeconds, 55); // 15 s + 10 * 4 s
});

test('applyEvent: records done and error (error code only from the allow-list)', () => {
	const p = newJobProgress();
	applyEvent(p, { type: 'error', message: 'kaput', code: 'PDF_DAMAGED' });
	assert.equal(p.error, 'kaput');
	assert.equal(p.errorCode, 'PDF_DAMAGED');
	const q = newJobProgress();
	applyEvent(q, { type: 'error', message: 'x', code: 'PROCESS_TIMEOUT' });
	assert.equal(q.errorCode, null);
	const r = newJobProgress();
	const done: ConvertEvent = { type: 'done', outPath: 'a.md', frontmatter: {}, warnings: [] };
	applyEvent(r, done);
	assert.equal(r.done, done);
});

function errCode(o: WorkerOutcome): string | undefined {
	return o.kind === 'error' ? (o.error as AppError).code : undefined;
}

test('classifyEnd: done wins, then error, otherwise CONVERSION_FAILED', () => {
	const p = newJobProgress();
	assert.equal(errCode(classifyEnd(p, 1)), 'CONVERSION_FAILED');
	applyEvent(p, { type: 'error', message: 'boom' });
	const e = classifyEnd(p, 1);
	assert.equal(errCode(e), 'CONVERSION_FAILED');
	assert.deepEqual((e as { error: AppError }).error.params, { detail: 'boom' });
	applyEvent(p, { type: 'done', outPath: 'a.md', frontmatter: {}, warnings: [] });
	assert.equal(classifyEnd(p, 0).kind, 'done');
});

test('classifyEnd: a forwarded code is passed through without detail', () => {
	const p = newJobProgress();
	applyEvent(p, { type: 'error', message: 'pdf', code: 'PDF_DAMAGED' });
	const o = classifyEnd(p, 1);
	assert.equal(errCode(o), 'PDF_DAMAGED');
	assert.equal((o as { error: AppError }).error.params, undefined);
});

test('classifyExit: timeout beats everything, with the current budget', () => {
	const p = newJobProgress();
	applyEvent(p, { type: 'progress', stage: 'converting', pageCount: 3 });
	applyEvent(p, { type: 'done', outPath: 'a.md', frontmatter: {}, warnings: [] });
	p.timedOut = true;
	const o = classifyExit(p, null, 'SIGTERM', '');
	assert.equal(errCode(o), 'PROCESS_TIMEOUT');
	assert.deepEqual((o as { error: AppError }).error.params, { seconds: Math.round(pdfTimeoutMs(3) / 1000) });
});

test('classifyExit: done / error already received, then native crash, then generic failure', () => {
	const done = newJobProgress();
	applyEvent(done, { type: 'done', outPath: 'a.md', frontmatter: {}, warnings: [] });
	assert.equal(classifyExit(done, 0xc0000374, null, '').kind, 'done');

	const failed = newJobProgress();
	applyEvent(failed, { type: 'error', message: 'nope' });
	assert.equal(errCode(classifyExit(failed, 0xc0000374, null, '')), 'CONVERSION_FAILED');

	const crash = classifyExit(newJobProgress(), 0xc0000005, null, 'x'.repeat(1000));
	assert.equal(crash.kind, 'crash');
	assert.ok((crash as { detail: string }).detail.length < 400);

	const plain = classifyExit(newJobProgress(), 1, null, 'Traceback...');
	assert.equal(errCode(plain), 'CONVERSION_FAILED');
	assert.match(String((plain as { error: AppError }).error.params?.detail), /exit 1: Traceback/);
	// DLL init failure is deterministic, never a crash.
	assert.equal(classifyExit(newJobProgress(), 3221225794, null, '').kind, 'error');
});

test('appendTail keeps the last N characters', () => {
	assert.equal(appendTail('abc', 'def', 4), 'cdef');
	assert.equal(appendTail('', 'ab', 10), 'ab');
});

// ---- worker with a fake child -------------------------------------------

class FakeChild extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	requests: { id: string; args: string[] }[] = [];
	killed = 0;
	stdinEnded = false;
	closed = false;
	constructor() {
		super();
		this.stdin.on('data', (d: Buffer) => {
			for (const line of d.toString().split('\n')) if (line.trim()) this.requests.push(JSON.parse(line));
		});
		// EOF on stdin = clean exit 0, like convert.py.
		this.stdin.on('finish', () => {
			this.stdinEnded = true;
			setImmediate(() => this.close(0, null));
		});
	}
	close(code: number | null, signal: NodeJS.Signals | null) {
		if (this.closed) return;
		this.closed = true;
		this.emit('close', code, signal);
	}
	kill() {
		this.killed++;
		setImmediate(() => this.close(null, 'SIGTERM'));
		return true;
	}
	send(obj: Record<string, unknown>) {
		this.stdout.write(JSON.stringify(obj) + '\n');
	}
	/** Replies to the latest request: events, then `end`. */
	reply(events: Record<string, unknown>[], exit = 0) {
		const id = this.requests[this.requests.length - 1].id;
		for (const e of events) this.send({ ...e, id });
		this.send({ type: 'end', id, exit });
	}
}

const DONE = { type: 'done', outPath: 'out/a.md', frontmatter: {}, warnings: [] };

const ticks = async (n = 5) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function harness(opts: { idleMs?: number; recycleAfter?: number; spawnThrows?: boolean } = {}) {
	const children: FakeChild[] = [];
	const worker = createConvertWorker({
		spawn: () => {
			if (opts.spawnThrows) throw new Error('python yok');
			const c = new FakeChild();
			children.push(c);
			return c as unknown as WorkerChild;
		},
		idleMs: opts.idleMs ?? 0, // 0 = no idle timer unless a test asks for one
		recycleAfter: opts.recycleAfter,
		shutdownGraceMs: 50
	});
	return { worker, children };
}

test('worker: spawns lazily, routes events by id, strips the id, resolves on end', async () => {
	const { worker, children } = harness();
	assert.equal(children.length, 0);
	const seen: ConvertEvent[] = [];
	const p = worker.run(['--in', 'a.pdf'], (e) => seen.push(e));
	await ticks();
	assert.equal(children.length, 1);
	assert.deepEqual(children[0].requests[0].args, ['--in', 'a.pdf']);
	const c = children[0];
	c.send({ type: 'progress', stage: 'converting', pageCount: 4, id: 'baska' }); // someone else's id
	c.send({ type: 'progress', stage: 'noise' }); // no id
	c.stdout.write('docling yukleniyor...\n'); // not JSON
	c.reply([{ type: 'progress', stage: 'converting', pageCount: 4 }, DONE]);
	const out = await p;
	assert.equal(out.kind, 'done');
	assert.deepEqual(
		seen.map((e) => e.type),
		['progress', 'done']
	);
	assert.ok(!('id' in seen[0]));
	assert.equal((seen[0] as { estimatedSeconds?: number }).estimatedSeconds, 31);
	assert.equal(worker.isBusy(), false);
	assert.equal(worker.isRunning(), true);
});

test('worker: requests run strictly one at a time on the same process (FIFO)', async () => {
	const { worker, children } = harness();
	const a = worker.run(['--in', '1']);
	const b = worker.run(['--in', '2']);
	const c = worker.run(['--in', '3']);
	await ticks();
	assert.equal(children.length, 1);
	assert.equal(children[0].requests.length, 1); // only the first is sent
	children[0].reply([DONE]);
	await a;
	await ticks();
	assert.equal(children[0].requests.length, 2);
	assert.deepEqual(children[0].requests[1].args, ['--in', '2']);
	children[0].reply([DONE]);
	await b;
	await ticks();
	assert.deepEqual(children[0].requests[2].args, ['--in', '3']);
	children[0].reply([{ type: 'error', message: 'kapali', code: 'PDF_DAMAGED' }], 1);
	const out = await c;
	assert.equal(errCode(out), 'PDF_DAMAGED');
	assert.equal(children.length, 1); // never respawned
	const ids = new Set(children[0].requests.map((r) => r.id));
	assert.equal(ids.size, 3);
});

test('worker: an error request leaves the worker serving', async () => {
	const { worker, children } = harness();
	const a = worker.run(['x']);
	await ticks();
	children[0].reply([{ type: 'error', message: 'Dosya bulunamadi' }], 1);
	assert.equal(errCode(await a), 'CONVERSION_FAILED');
	const b = worker.run(['y']);
	await ticks();
	children[0].reply([DONE]);
	assert.equal((await b).kind, 'done');
	assert.equal(children.length, 1);
});

test('worker: end without done or error -> CONVERSION_FAILED', async () => {
	const { worker, children } = harness();
	const a = worker.run(['x']);
	await ticks();
	children[0].reply([{ type: 'progress', stage: 'converting' }], 1);
	assert.equal(errCode(await a), 'CONVERSION_FAILED');
});

test('worker: a native crash mid-request is a crash outcome; the next request gets a fresh worker', async () => {
	const { worker, children } = harness();
	const a = worker.run(['x']);
	await ticks();
	children[0].stderr.write('boom in docling-parse');
	await ticks();
	children[0].close(0xc0000374, null);
	const out = await a;
	assert.equal(out.kind, 'crash');
	assert.match((out as { detail: string }).detail, /boom in docling-parse/);
	const b = worker.run(['x', '--pdf-backend', 'hybrid']);
	await ticks();
	assert.equal(children.length, 2);
	assert.deepEqual(children[1].requests[0].args, ['x', '--pdf-backend', 'hybrid']);
	children[1].reply([DONE]);
	assert.equal((await b).kind, 'done');
});

test('worker: a non-crash exit mid-request is CONVERSION_FAILED with stderr', async () => {
	const { worker, children } = harness();
	const a = worker.run(['x']);
	await ticks();
	children[0].stderr.write('MemoryError');
	await ticks();
	children[0].close(1, null);
	const out = await a;
	assert.equal(errCode(out), 'CONVERSION_FAILED');
	assert.match(String((out as { error: AppError }).error.params?.detail), /MemoryError/);
});

test('worker: a crash after done still counts as success', async () => {
	const { worker, children } = harness();
	const a = worker.run(['x']);
	await ticks();
	children[0].send({ ...DONE, id: children[0].requests[0].id });
	await ticks();
	children[0].close(0xc0000005, null);
	assert.equal((await a).kind, 'done');
});

test('worker: spawn failures -> PYTHON_SPAWN_FAILED', async () => {
	const { worker } = harness({ spawnThrows: true });
	assert.equal(errCode(await worker.run(['x'])), 'PYTHON_SPAWN_FAILED');

	const { worker: w2, children } = harness();
	const p = w2.run(['x']);
	await ticks();
	children[0].emit('error', new Error('spawn ENOENT'));
	const out = await p;
	assert.equal(errCode(out), 'PYTHON_SPAWN_FAILED');
	assert.match(String((out as { error: AppError }).error.params?.detail), /ENOENT/);
});

test('worker: timeout floor kills the worker and resolves PROCESS_TIMEOUT; next request spawns anew', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const { worker, children } = harness();
		const a = worker.run(['x']);
		await ticks();
		mock.timers.tick(PROCESS_TIMEOUT_MS - 1);
		assert.equal(children[0].killed, 0);
		mock.timers.tick(1);
		assert.equal(children[0].killed, 1);
		const out = await a;
		assert.equal(errCode(out), 'PROCESS_TIMEOUT');
		assert.deepEqual((out as { error: AppError }).error.params, { seconds: PROCESS_TIMEOUT_MS / 1000 });
		const b = worker.run(['y']);
		await ticks();
		assert.equal(children.length, 2);
		children[1].reply([DONE]);
		assert.equal((await b).kind, 'done');
	} finally {
		mock.timers.reset();
	}
});

test('worker: the pageCount event replaces the floor with the page-aware budget', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const { worker, children } = harness();
		const a = worker.run(['x']);
		await ticks();
		children[0].send({ type: 'progress', stage: 'converting', pageCount: 5, id: children[0].requests[0].id });
		await ticks();
		const budget = pdfTimeoutMs(5);
		assert.ok(budget > PROCESS_TIMEOUT_MS);
		mock.timers.tick(PROCESS_TIMEOUT_MS + 1000); // floor would have fired
		assert.equal(children[0].killed, 0);
		mock.timers.tick(budget - PROCESS_TIMEOUT_MS - 1000);
		assert.equal(children[0].killed, 1);
		const out = await a;
		assert.deepEqual((out as { error: AppError }).error.params, { seconds: Math.round(budget / 1000) });
	} finally {
		mock.timers.reset();
	}
});

test('worker: the timer starts when the request reaches the worker, not when it is queued', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const { worker, children } = harness();
		const a = worker.run(['1']);
		const b = worker.run(['2']);
		await ticks();
		mock.timers.tick(PROCESS_TIMEOUT_MS - 10);
		children[0].reply([DONE]);
		await a;
		await ticks();
		mock.timers.tick(PROCESS_TIMEOUT_MS - 10); // b's own budget not used up yet
		assert.equal(children[0].killed, 0);
		children[0].reply([DONE]);
		assert.equal((await b).kind, 'done');
	} finally {
		mock.timers.reset();
	}
});

test('worker: idle timeout closes stdin, and the next request spawns a new worker', async () => {
	const { worker, children } = harness({ idleMs: 20 });
	const a = worker.run(['x']);
	await ticks();
	children[0].reply([DONE]);
	await a;
	assert.equal(children[0].stdinEnded, false);
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(children[0].stdinEnded, true);
	assert.equal(children[0].killed, 0); // exited on EOF by itself
	assert.equal(worker.isRunning(), false);
	const b = worker.run(['y']);
	await ticks();
	assert.equal(children.length, 2);
	children[1].reply([DONE]);
	await b;
});

test('worker: a new request cancels the idle timer', async () => {
	const { worker, children } = harness({ idleMs: 40 });
	const a = worker.run(['x']);
	await ticks();
	children[0].reply([DONE]);
	await a;
	await new Promise((r) => setTimeout(r, 25));
	const b = worker.run(['y']); // before the 40 ms idle timer fires
	await ticks();
	await new Promise((r) => setTimeout(r, 40)); // long past the first deadline, still busy
	assert.equal(children[0].stdinEnded, false);
	children[0].reply([DONE]);
	await b;
	assert.equal(children.length, 1);
});

test('worker: an idle worker that ignores EOF is killed after the grace period', async () => {
	const { worker, children } = harness();
	const a = worker.run(['x']);
	await ticks();
	children[0].reply([DONE]);
	await a;
	// A stuck worker: ignores stdin EOF.
	children[0].stdin.removeAllListeners('finish');
	children[0].stdin.on('finish', () => {
		children[0].stdinEnded = true;
	});
	await worker.release();
	assert.equal(children[0].stdinEnded, true);
	assert.equal(children[0].killed, 1);
	assert.equal(worker.isRunning(), false);
});

test('worker: release() shuts down an idle worker and is a no-op while busy', async () => {
	const { worker, children } = harness();
	await worker.release(); // nothing running: fine
	const a = worker.run(['x']);
	await ticks();
	await worker.release(); // busy: no-op
	assert.equal(children[0].stdinEnded, false);
	children[0].reply([DONE]);
	await a;
	await worker.release();
	assert.equal(children[0].stdinEnded, true);
	assert.equal(worker.isRunning(), false);
});

test('worker: recycles after N conversions and waits for the old process before starting the new one', async () => {
	const { worker, children } = harness({ recycleAfter: 2 });
	for (let i = 0; i < 2; i++) {
		const p = worker.run([String(i)]);
		await ticks();
		children[0].reply([DONE]);
		await p;
	}
	// Third request queued right behind the second: must go to a NEW process.
	const c = worker.run(['2']);
	await ticks(10);
	assert.equal(children[0].stdinEnded, true);
	assert.equal(children.length, 2);
	assert.deepEqual(children[1].requests[0].args, ['2']);
	children[1].reply([DONE]);
	assert.equal((await c).kind, 'done');
});

test('worker: stale output of a replaced worker is ignored', async () => {
	const { worker, children } = harness();
	const a = worker.run(['x']);
	await ticks();
	children[0].close(0xc0000005, null);
	await a;
	const b = worker.run(['y']);
	await ticks();
	// The dead worker's stdout cannot answer the new request.
	children[0].send({ type: 'done', outPath: 'stale.md', frontmatter: {}, warnings: [], id: children[1].requests[0].id });
	children[0].send({ type: 'end', id: children[1].requests[0].id, exit: 0 });
	await ticks();
	assert.equal(worker.isBusy(), true);
	children[1].reply([DONE]);
	const out = await b;
	assert.equal(out.kind === 'done' && out.value.outPath, 'out/a.md');
});

test('releaseConverterWorker: delegates to the registered worker, no-op without one', async () => {
	setSharedConvertWorker(null);
	await releaseConverterWorker();
	let released = 0;
	const fake: ConvertWorker = {
		run: async () => ({ kind: 'crash', detail: '' }),
		release: async () => {
			released++;
		},
		kill: () => {},
		isBusy: () => false,
		isRunning: () => false
	};
	setSharedConvertWorker(fake);
	try {
		await releaseConverterWorker();
		assert.equal(released, 1);
	} finally {
		setSharedConvertWorker(null);
	}
});

test('pdfTimeoutMs: VC_PDF_TIMEOUT_PER_PAGE_MS overrides the per-page budget, junk falls back', () => {
	const prev = process.env.VC_PDF_TIMEOUT_PER_PAGE_MS;
	try {
		delete process.env.VC_PDF_TIMEOUT_PER_PAGE_MS;
		assert.equal(pdfTimeoutMs(10), 90_000 + 10 * 40_000);
		process.env.VC_PDF_TIMEOUT_PER_PAGE_MS = '60000';
		assert.equal(pdfTimeoutMs(10), 90_000 + 10 * 60_000);
		process.env.VC_PDF_TIMEOUT_PER_PAGE_MS = 'abc';
		assert.equal(pdfTimeoutMs(10), 90_000 + 10 * 40_000);
	} finally {
		if (prev === undefined) delete process.env.VC_PDF_TIMEOUT_PER_PAGE_MS;
		else process.env.VC_PDF_TIMEOUT_PER_PAGE_MS = prev;
	}
});
