import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_TEACHING_CHARS, isTeachingChunk, selectTeachingPool } from './quiz-pool';

const body = 'x'.repeat(MIN_TEACHING_CHARS + 20);
const chunk = (path: string, heading_path: string, display_text = body) => ({ path, heading_path, display_text });

test('a real content section is kept', () => {
	assert.equal(isTeachingChunk(chunk('wiki/os/process-scheduling.md', 'Process Scheduling: Policies and Mechanisms > The scheduler')), true);
	assert.equal(isTeachingChunk(chunk('wiki/algorithms/sources/kleinberg-tardos-algorithm-design.md', 'Kleinberg & Tardos > Ch. 4 Greedy')), true);
});

test('index pages and metadata folders are not teaching material', () => {
	assert.equal(isTeachingChunk(chunk('wiki/_index/MOC - algorithms.md', 'MOC - algorithms > Learning Path > Computational Complexity')), false);
	assert.equal(isTeachingChunk(chunk('_meta/health-report-2026-08-07.md', 'Health report')), false);
	assert.equal(isTeachingChunk(chunk('wiki/os/MOC - os.md', 'Overview')), false);
});

test('Related / Sources / See also / Recently Added sections teach nothing', () => {
	for (const h of ['Pointers in C > Related', 'Parameterized Complexity > Sources', 'Unix Process Model > See also', 'MOC - c > Recently Added', 'X > References', 'X > Further reading']) {
		assert.equal(isTeachingChunk(chunk('wiki/c/x.md', h)), false, h);
	}
});

test('only the LAST heading segment decides, so "Sources" as a parent topic does not exclude a real subsection', () => {
	assert.equal(isTeachingChunk(chunk('wiki/x/y.md', 'Sources of error in floating point > Rounding')), true);
	assert.equal(isTeachingChunk(chunk('wiki/x/y.md', 'Related rates > Worked example')), true);
});

test('a section too short to ask about is dropped', () => {
	assert.equal(isTeachingChunk(chunk('wiki/x/y.md', 'A > B', 'short')), false);
	assert.equal(isTeachingChunk(chunk('wiki/x/y.md', 'A > B', 'y'.repeat(MIN_TEACHING_CHARS))), true);
});

test('the pool keeps rank order and honours the limit', () => {
	const chunks = [
		chunk('wiki/_index/MOC - a.md', 'MOC'),
		chunk('wiki/a/one.md', 'One > A'),
		chunk('wiki/a/two.md', 'Two > Related'),
		chunk('wiki/a/three.md', 'Three > B'),
		chunk('wiki/a/four.md', 'Four > C')
	];
	assert.deepEqual(selectTeachingPool(chunks, 2).map((c) => c.path), ['wiki/a/one.md', 'wiki/a/three.md']);
	assert.deepEqual(selectTeachingPool(chunks, 10).map((c) => c.path), ['wiki/a/one.md', 'wiki/a/three.md', 'wiki/a/four.md']);
});

test('a vault of nothing but link pages still yields a pool rather than "no sources"', () => {
	const chunks = [chunk('wiki/_index/MOC - a.md', 'MOC'), chunk('wiki/a/x.md', 'X > Related')];
	assert.equal(selectTeachingPool(chunks, 12).length, 2);
	assert.deepEqual(selectTeachingPool([], 12), []);
});
