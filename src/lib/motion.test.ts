import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionEase, prefersReducedMotion, flipDuration } from './motion';

test('motionEase returns 0 at 0 and 1 at 1', () => {
	assert.equal(motionEase(0), 0);
	assert.equal(motionEase(1), 1);
});

test('motionEase is monotonically increasing over a sample grid', () => {
	let previous = motionEase(0);
	for (let i = 1; i <= 20; i++) {
		const x = i / 20;
		const y = motionEase(x);
		assert.ok(y >= previous, `motionEase(${x}) = ${y} should be >= previous ${previous}`);
		previous = y;
	}
});

test('motionEase is an ease-out curve: progress at the midpoint is past halfway', () => {
	// cubic-bezier(0.2, 0, 0, 1) front-loads progress (slow start control
	// point at (0.2, 0), instant-departure end control point at (0, 1)) —
	// by x=0.5 the curve should already be past y=0.5.
	const mid = motionEase(0.5);
	assert.ok(mid > 0.5, `expected motionEase(0.5) > 0.5, got ${mid}`);
	assert.ok(mid < 1, `expected motionEase(0.5) < 1, got ${mid}`);
});

test('prefersReducedMotion is false when window is undefined (SSR)', () => {
	assert.equal(typeof window, 'undefined');
	assert.equal(prefersReducedMotion(), false);
});

test('prefersReducedMotion reflects a stubbed matchMedia', () => {
	const original = (globalThis as { window?: unknown }).window;
	try {
		(globalThis as { window?: unknown }).window = {
			matchMedia: (_query: string) => ({ matches: true })
		};
		assert.equal(prefersReducedMotion(), true);

		(globalThis as { window?: unknown }).window = {
			matchMedia: (_query: string) => ({ matches: false })
		};
		assert.equal(prefersReducedMotion(), false);
	} finally {
		if (original === undefined) delete (globalThis as { window?: unknown }).window;
		else (globalThis as { window?: unknown }).window = original;
	}
});

test('prefersReducedMotion: the data-motion attribute overrides matchMedia', () => {
	const g = globalThis as { window?: unknown; document?: unknown };
	const origWindow = g.window;
	const origDocument = g.document;
	try {
		g.window = { matchMedia: (_query: string) => ({ matches: false }) };
		g.document = { documentElement: { dataset: { motion: 'reduce' } } };
		assert.equal(prefersReducedMotion(), true);

		g.window = { matchMedia: (_query: string) => ({ matches: true }) };
		g.document = { documentElement: { dataset: { motion: 'full' } } };
		assert.equal(prefersReducedMotion(), false);

		// Attribute absent → falls back to matchMedia.
		g.document = { documentElement: { dataset: {} } };
		assert.equal(prefersReducedMotion(), true);
	} finally {
		if (origWindow === undefined) delete g.window;
		else g.window = origWindow;
		if (origDocument === undefined) delete g.document;
		else g.document = origDocument;
	}
});

test('flipDuration is 0 under reduced motion and MOTION.fast otherwise', () => {
	const original = (globalThis as { window?: unknown }).window;
	try {
		(globalThis as { window?: unknown }).window = {
			matchMedia: (_query: string) => ({ matches: true })
		};
		assert.equal(flipDuration(), 0);

		(globalThis as { window?: unknown }).window = {
			matchMedia: (_query: string) => ({ matches: false })
		};
		assert.equal(flipDuration(), 150);
	} finally {
		if (original === undefined) delete (globalThis as { window?: unknown }).window;
		else (globalThis as { window?: unknown }).window = original;
	}
});
