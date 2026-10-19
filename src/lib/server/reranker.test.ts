import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createReranker, decideRerankGate, RERANKER_VRAM_MB, RERANKER_VRAM_MB_BESIDE_RESIDENT, type PsModel, type RerankChild } from './reranker';

type Behaviour = {
	/** First stdout line; null = never send it (a hung start). */
	first?: string | null;
	/** Reply to one request line; null = never answer. */
	reply?: (req: { query: string; passages: string[] }) => string | null;
	/** Exit right after the first line (a failed start). */
	exitAfterFirst?: number;
};

class FakeChild extends EventEmitter implements RerankChild {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	killed = false;
	stdinEnded = false;
	requests: { query: string; passages: string[] }[] = [];

	constructor(private readonly b: Behaviour) {
		super();
		queueMicrotask(() => {
			if (b.first !== null) this.stdout.write((b.first ?? '{"ready":true,"load_ms":1,"device":"cuda"}') + '\n');
			if (b.exitAfterFirst !== undefined) this.close(b.exitAfterFirst);
		});
		let buf = '';
		this.stdin.on('data', (d: Buffer) => {
			buf += d.toString();
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				const req = JSON.parse(line) as { query: string; passages: string[] };
				this.requests.push(req);
				const out = (b.reply ?? ((r) => JSON.stringify({ id: 'r', scores: r.passages.map(() => 0.5), ms: 1 })))(req);
				if (out !== null) this.stdout.write(out + '\n');
			}
		});
		this.stdin.on('end', () => {
			this.stdinEnded = true;
			setTimeout(() => this.close(0), 1);
		});
	}

	close(code: number | null): void {
		this.emit('close', code, null);
	}

	kill(): boolean {
		this.killed = true;
		setTimeout(() => this.close(null), 1);
		return true;
	}
}

function harness(behaviours: Behaviour[], over: Parameters<typeof createReranker>[0] extends infer D ? Partial<D> : never = {}) {
	const children: FakeChild[] = [];
	const failures: string[] = [];
	const r = createReranker({
		spawn: () => {
			const b = behaviours[Math.min(children.length, behaviours.length - 1)];
			const c = new FakeChild(b);
			children.push(c);
			return c;
		},
		onFailure: (m) => failures.push(m),
		requestTimeoutMs: 80,
		startTimeoutMs: 120,
		failureBackoffMs: 60_000,
		shutdownGraceMs: 50,
		...over
	});
	return { r, children, failures };
}

test('scores come back in passage order and the process is reused', async () => {
	const { r, children } = harness([{ reply: (q) => JSON.stringify({ id: 'r', scores: q.passages.map((_, i) => i / 10), ms: 1 }) }]);
	assert.deepEqual(await r.rerank('q', ['a', 'b', 'c']), [0, 0.1, 0.2]);
	assert.deepEqual(await r.rerank('q2', ['x']), [0]);
	assert.equal(children.length, 1);
	assert.deepEqual(children[0].requests.map((x) => x.query), ['q', 'q2']);
	await r.release();
});

test('an empty passage list needs no process', async () => {
	const { r, children } = harness([{}]);
	assert.deepEqual(await r.rerank('q', []), []);
	assert.equal(children.length, 0);
});

test('concurrent calls are answered in order over the single pipe', async () => {
	const { r } = harness([{ reply: (q) => JSON.stringify({ id: 'r', scores: q.passages.map(() => Number(q.query)), ms: 1 }) }]);
	const out = await Promise.all([r.rerank('1', ['a']), r.rerank('2', ['a']), r.rerank('3', ['a'])]);
	assert.deepEqual(out, [[1], [2], [3]]);
	await r.release();
});

test('a request that is not answered in time yields null, kills the process and backs off', async () => {
	const { r, children, failures } = harness([{ reply: () => null }]);
	assert.equal(await r.rerank('q', ['a']), null);
	assert.equal(children[0].killed, true);
	assert.equal(failures.length, 1);
	assert.match(failures[0], /içinde gelmedi/);
	// within the back-off window nothing is spawned again
	assert.equal(await r.rerank('q', ['a']), null);
	assert.equal(children.length, 1);
	assert.equal(failures.length, 1);
});

test('a start that never reports ready times out with null', async () => {
	const { r, children, failures } = harness([{ first: null }]);
	assert.equal(await r.rerank('q', ['a']), null);
	assert.equal(children[0].killed, true);
	assert.match(failures[0], /başlatma/);
});

test('a CPU-only start is refused: no fallback to the CPU', async () => {
	const { r, children, failures } = harness([{ first: '{"ready":true,"load_ms":1,"device":"cpu"}' }]);
	assert.equal(await r.rerank('q', ['a']), null);
	assert.equal(children[0].killed, true);
	assert.match(failures[0], /cuda gerekli/);
});

test('the server reporting no CUDA is a null with its reason', async () => {
	const { r, failures } = harness([{ first: '{"error":"cuda-unavailable"}', exitAfterFirst: 3 }]);
	assert.equal(await r.rerank('q', ['a']), null);
	assert.match(failures[0], /cuda-unavailable/);
});

test('a server error line and a malformed score list both yield null', async () => {
	const a = harness([{ reply: () => JSON.stringify({ id: 'r', error: 'boom' }) }]);
	assert.equal(await a.r.rerank('q', ['a']), null);
	assert.match(a.failures[0], /boom/);
	const b = harness([{ reply: () => JSON.stringify({ id: 'r', scores: [0.1], ms: 1 }) }]);
	assert.equal(await b.r.rerank('q', ['a', 'b']), null);
	assert.match(b.failures[0], /geçersiz skor/);
});

test('a spawn that throws (no Python) yields null', async () => {
	const failures: string[] = [];
	const r = createReranker({
		spawn: () => {
			throw new Error('python bulunamadı');
		},
		onFailure: (m) => failures.push(m)
	});
	assert.equal(await r.rerank('q', ['a']), null);
	assert.deepEqual(failures, ['python bulunamadı']);
});

test('the same failure is reported once; a success re-arms the report', async () => {
	let n = 0;
	const { r, failures } = harness([{ reply: () => (++n === 3 ? JSON.stringify({ id: 'r', scores: [0.3], ms: 1 }) : JSON.stringify({ id: 'r', error: 'x' })) }], {
		failureBackoffMs: 0
	});
	assert.equal(await r.rerank('q', ['a']), null);
	assert.equal(await r.rerank('q', ['a']), null);
	assert.equal(failures.length, 1);
	assert.deepEqual(await r.rerank('q', ['a']), [0.3]);
	await r.release();
});

test('release() closes stdin and resolves once the process is gone', async () => {
	const { r, children } = harness([{}]);
	await r.rerank('q', ['a']);
	assert.equal(r.isRunning(), true);
	await r.release();
	assert.equal(children[0].stdinEnded, true);
	assert.equal(r.isRunning(), false);
	// and the next call starts a fresh process
	assert.deepEqual(await r.rerank('q', ['a']), [0.5]);
	assert.equal(children.length, 2);
	await r.release();
});

test('an idle process is shut down by itself', async () => {
	const { r, children } = harness([{}], { idleMs: 30 });
	await r.rerank('q', ['a']);
	await new Promise((res) => setTimeout(res, 120));
	assert.equal(children[0].stdinEnded, true);
	assert.equal(r.isRunning(), false);
});

// --- VRAM gate -------------------------------------------------------------

const GB = 1024 ** 3;
const full = (name: string): PsModel => ({ name, size: 5.6 * GB, size_vram: 5.6 * GB });
const partial = (name: string): PsModel => ({ name, size: 5.6 * GB, size_vram: 4.59 * GB });

test('gate: chat model not in /api/ps -> skip and release (it loads this turn without the reranker)', () => {
	assert.deepEqual(decideRerankGate({ localModel: 'qwen3:8b', ps: [], running: true, freeVramMb: null }), { action: 'skip-release', reason: 'chat-model-not-loaded' });
	assert.deepEqual(decideRerankGate({ localModel: 'qwen3:8b', ps: [full('bge-m3:latest')], running: false, freeVramMb: 4000 }), {
		action: 'skip-release',
		reason: 'chat-model-not-loaded'
	});
	// Ollama unreachable counts as not loaded
	assert.equal(decideRerankGate({ localModel: 'qwen3:8b', ps: null, running: false, freeVramMb: 4000 }).action, 'skip-release');
});

test('gate: chat model partly on the CPU -> skip and release', () => {
	assert.deepEqual(decideRerankGate({ localModel: 'qwen3:8b', ps: [partial('qwen3:8b')], running: true, freeVramMb: null }), {
		action: 'skip-release',
		reason: 'chat-model-offloaded'
	});
});

test('gate: chat model fully on the GPU -> run (latest tag and bare name are one model)', () => {
	assert.deepEqual(decideRerankGate({ localModel: 'qwen3-x', ps: [full('qwen3-x:latest')], running: true, freeVramMb: null }), { action: 'run' });
	assert.deepEqual(decideRerankGate({ localModel: 'qwen3:8b-bart-iq4xs', ps: [full('qwen3:8b-bart-iq4xs')], running: false, freeVramMb: 2000 }), { action: 'run' });
});

test('gate: not running and too little free VRAM -> skip without releasing', () => {
	assert.deepEqual(decideRerankGate({ localModel: 'm', ps: [full('m')], running: false, freeVramMb: RERANKER_VRAM_MB_BESIDE_RESIDENT - 1 }), { action: 'skip', reason: 'insufficient-vram' });
	assert.deepEqual(decideRerankGate({ ps: null, running: false, freeVramMb: RERANKER_VRAM_MB - 1 }), { action: 'skip', reason: 'insufficient-vram' });
	assert.deepEqual(decideRerankGate({ ps: null, running: false, freeVramMb: 300 }), { action: 'skip', reason: 'insufficient-vram' });
});

test('gate: beside a fully resident local chat model the lower threshold applies (measured spill is harmless)', () => {
	assert.deepEqual(decideRerankGate({ localModel: 'm', ps: [full('m')], running: false, freeVramMb: 1075 }), { action: 'run' });
	assert.deepEqual(decideRerankGate({ localModel: 'm', ps: [full('m')], running: false, freeVramMb: RERANKER_VRAM_MB_BESIDE_RESIDENT }), { action: 'run' });
});

test('gate: enough free VRAM, unknown VRAM (no nvidia-smi) or a live process -> run; cloud chat needs no ps', () => {
	assert.deepEqual(decideRerankGate({ ps: null, running: false, freeVramMb: RERANKER_VRAM_MB }), { action: 'run' });
	assert.deepEqual(decideRerankGate({ ps: null, running: false, freeVramMb: null }), { action: 'run' });
	// a running process's own memory is already counted as used: no VRAM check
	assert.deepEqual(decideRerankGate({ ps: null, running: true, freeVramMb: 10 }), { action: 'run' });
});
