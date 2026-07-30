import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThinkTagNormalizer } from './normalize';

function collect(chunks: ReturnType<ReturnType<typeof createThinkTagNormalizer>['feed']>[]) {
	return chunks.flat();
}

test('plain text with no think tags at all passes through unchanged', () => {
	const n = createThinkTagNormalizer();
	const out = collect([n.feed('Merhaba, nasılsın?')]);
	assert.deepEqual(out, [{ type: 'text', text: 'Merhaba, nasılsın?' }]);
	assert.deepEqual(n.flush(), []);
});

test('a single think block in one feed call splits into reasoning + text', () => {
	const n = createThinkTagNormalizer();
	const out = collect([n.feed('before <think>reasoning here</think> after')]);
	assert.deepEqual(out, [
		{ type: 'text', text: 'before ' },
		{ type: 'reasoning', text: 'reasoning here' },
		{ type: 'text', text: ' after' }
	]);
});

test('opening tag split across two chunks ("<th" + "ink>") is not leaked as text', () => {
	const n = createThinkTagNormalizer();
	const first = n.feed('hello <th');
	const second = n.feed('ink>secret');
	assert.deepEqual(first, [{ type: 'text', text: 'hello ' }]);
	assert.deepEqual(second, [{ type: 'reasoning', text: 'secret' }]);
});

test('closing tag split across two chunks ("</th" + "ink>") is not leaked as reasoning', () => {
	const n = createThinkTagNormalizer();
	// "secret" streams out immediately as reasoning — it doesn't need to
	// wait for the closing tag, since nothing about it is ambiguous.
	const opened = n.feed('<think>secret');
	const beforeClose = n.feed('</th');
	const afterClose = n.feed('ink>visible');
	assert.deepEqual(opened, [{ type: 'reasoning', text: 'secret' }]);
	assert.deepEqual(beforeClose, []); // "</th" entirely buffered — still an unresolved prefix
	assert.deepEqual(afterClose, [{ type: 'text', text: 'visible' }]);
});

test('tag split one character at a time still resolves correctly', () => {
	const n = createThinkTagNormalizer();
	const out: unknown[] = [];
	for (const ch of 'x<think>y</think>z') out.push(...n.feed(ch));
	assert.deepEqual(out, [
		{ type: 'text', text: 'x' },
		{ type: 'reasoning', text: 'y' },
		{ type: 'text', text: 'z' }
	]);
});

test('multiple think blocks in one stream', () => {
	const n = createThinkTagNormalizer();
	const out = collect([n.feed('<think>a</think>mid<think>b</think>end')]);
	assert.deepEqual(out, [
		{ type: 'reasoning', text: 'a' },
		{ type: 'text', text: 'mid' },
		{ type: 'reasoning', text: 'b' },
		{ type: 'text', text: 'end' }
	]);
});

test('a lone "<" at the very end of the stream is flushed as text, not lost', () => {
	const n = createThinkTagNormalizer();
	// "done" is safe to emit immediately; only the trailing "<" is
	// ambiguous (could still turn into "<think>") and gets buffered.
	const out = collect([n.feed('done<')]);
	assert.deepEqual(out, [{ type: 'text', text: 'done' }]);
	const flushed = n.flush();
	assert.deepEqual(flushed, [{ type: 'text', text: '<' }]);
});

test('a false-start prefix that never completes into the marker is eventually emitted as text', () => {
	const n = createThinkTagNormalizer();
	// "<th" looks like the start of <think> but the next char breaks it
	const out = collect([n.feed('<thx')]);
	assert.deepEqual(out, [{ type: 'text', text: '<thx' }]);
});
