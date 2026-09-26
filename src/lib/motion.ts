import { fly, fade, type FlyParams } from 'svelte/transition';

/**
 * Mirrors src/styles/tokens.css's --motion-fast / --motion-base (150ms /
 * 200ms) — kept in sync by hand since Svelte's transition functions run
 * through the Web Animations API (element.animate()), which cannot read a
 * CSS custom property the way a `transition:` / `animation:` declaration
 * can. If tokens.css changes, update this too.
 */
export const MOTION = { fast: 150, base: 200 } as const;

/**
 * tokens.css's --motion-easing is cubic-bezier(0.2, 0, 0, 1) — an ease-out
 * curve (DESIGN.md: ease-out only, never bounce/elastic). Svelte's
 * transition params take an `easing: (t: number) => number` function, not a
 * CSS string, so the same curve is reproduced here rather than duplicated as
 * a second, possibly-drifting definition.
 *
 * Solves x(t) = t for the bezier parameter t given a progress fraction x
 * (Newton-Raphson, falling back to bisection if a step ever leaves [0, 1] or
 * the derivative is ~0), then returns y(t) — the standard technique for
 * evaluating a CSS cubic-bezier easing function outside the browser's own
 * implementation of it.
 */
const BEZIER_X1 = 0.2;
const BEZIER_Y1 = 0;
const BEZIER_X2 = 0;
const BEZIER_Y2 = 1;

function bezierComponent(t: number, p1: number, p2: number): number {
	const oneMinusT = 1 - t;
	return 3 * oneMinusT * oneMinusT * t * p1 + 3 * oneMinusT * t * t * p2 + t * t * t;
}

function bezierComponentDerivative(t: number, p1: number, p2: number): number {
	const oneMinusT = 1 - t;
	return 3 * oneMinusT * oneMinusT * p1 + 6 * oneMinusT * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

function solveTForX(x: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;

	// Newton-Raphson first — fast and accurate for a well-behaved curve like
	// this one (monotonic, no steep vertical tangents).
	let t = x;
	for (let i = 0; i < 8; i++) {
		const currentX = bezierComponent(t, BEZIER_X1, BEZIER_X2) - x;
		const derivative = bezierComponentDerivative(t, BEZIER_X1, BEZIER_X2);
		if (Math.abs(derivative) < 1e-6) break;
		const next = t - currentX / derivative;
		if (!Number.isFinite(next) || next < 0 || next > 1) break;
		t = next;
		if (Math.abs(currentX) < 1e-7) return t;
	}

	// Bisection fallback — guaranteed to converge for a monotonic x(t) even
	// if Newton's step ever misbehaves (out-of-range or a near-zero slope).
	let lo = 0;
	let hi = 1;
	t = x;
	for (let i = 0; i < 30; i++) {
		const currentX = bezierComponent(t, BEZIER_X1, BEZIER_X2);
		if (Math.abs(currentX - x) < 1e-7) break;
		if (currentX < x) lo = t;
		else hi = t;
		t = (lo + hi) / 2;
	}
	return t;
}

/** cubic-bezier(0.2, 0, 0, 1) evaluated at progress fraction `x`. Returns 0
 * at 0, 1 at 1, and is monotonically increasing in between. */
export const motionEase = (x: number): number => bezierComponent(solveTForX(x), BEZIER_Y1, BEZIER_Y2);

/** True only in a browser that reports prefers-reduced-motion: reduce.
 * False during SSR (no `window`) and in any environment without
 * matchMedia. */
export function prefersReducedMotion(): boolean {
	return (
		typeof window !== 'undefined' &&
		window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
	);
}

/**
 * Svelte transition wrapper used at every `transition:`/`in:`/`out:fly` call
 * site in the app instead of svelte/transition's `fly` directly. Svelte 5's
 * transitions run through element.animate() (the Web Animations API), which
 * the CSS `prefers-reduced-motion` !important safety net in app.css cannot
 * reach — that net only overrides `animation-duration`/`transition-duration`
 * CSS properties. This is the actual reduced-motion gate for every Svelte
 * transition in the app: swap the spatial fly for an opacity-only fade
 * (same duration family, no movement) whenever the OS preference is set.
 */
export function motionFly(node: Element, params: FlyParams = {}) {
	if (prefersReducedMotion()) {
		return fade(node, { duration: MOTION.fast });
	}
	return fly(node, { duration: MOTION.base, easing: motionEase, ...params });
}

/** Duration to hand `animate:flip` — 0 (instant reorder) under reduced
 * motion, tokens.css's --motion-fast otherwise. flip runs through the same
 * Web Animations API path as fly/fade, so it needs the same explicit gate. */
export function flipDuration(): number {
	return prefersReducedMotion() ? 0 : MOTION.fast;
}
