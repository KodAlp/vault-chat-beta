/**
 * Decides whether a chat message is small talk (a greeting, slang, an insult, a
 * "test"), in which case retrieval is skipped and no sources are attached.
 * Pure and dependency-free so it runs under plain `tsx --test`; the phrase store
 * (smalltalk-store.ts) and the SvelteKit glue (smalltalk-runtime.ts) live elsewhere.
 *
 * Why this exists: the vector search cannot tell small talk from a question.
 * "Naber lan tipine çaktığım" came back at distance 0.535 — better than real
 * questions (0.318–0.569 on the real index) — so 6 sources were attached and the
 * model wove them into its answer ("Sizden bahsettiğiniz içerik, web temelleri ve
 * Svelte'in derleme zamanı felsefesi ile ilgilidir"). No distance threshold
 * separates the two, and a stopword list is wrong for every language and slang
 * it does not list, so the gate compares the message's own embedding (the one
 * retrieve() already computes, so it costs nothing extra) with known small-talk
 * phrases: multilingual seeds plus what this user has said or taught it.
 *
 * CALIBRATION SCOPE: every threshold below was measured ONLY with the bge-m3 embedding model
 * (1024 dims). Another model has a different similarity distribution (a nomic or qwen3 model's
 * unrelated-text cosines sit much higher), and a false "small talk" flag silently removes
 * grounding. So the gate is active only for that family (isGateCalibratedFor, whichever server
 * serves it) and OFF for any other embedding model — retrieval then proceeds normally. Using
 * another model has its thresholds derived at runtime from the seed/probe separation
 * (smalltalk-calibration.ts) and stays OFF until that succeeds.
 *
 * Measured on the real vault with bge-m3, against 2016 negatives (252 note titles
 * x 8 shapes: bare, "X nedir", "what is X", ..., with and without a greeting
 * prefix) and 95 held-out small-talk messages:
 *
 *  - The first candidate rule (seed similarity >= 0.65, corpus distance >= 0.5)
 *    caught 53/95 but wrongly flagged 13/2016 (0.64%), all greeting-prefixed
 *    questions about a one-word topic ("selam asm nedir"). A wrong flag silently
 *    removes grounding, so the rule was tightened until it flagged none.
 *  - SEED_SIM 0.78: 0/2016 wrong, margin 0.054 over the worst negative (0.726),
 *    catches 23/95 (24%). The seeds therefore only catch standard greetings the
 *    first time; that is the price of precision.
 *  - PERSONAL_SIM 0.82: a phrase the user already said or taught (or a typo /
 *    variant of it: "Merhabaa" 0.91, "napıyon lan" 0.89, "naber la" 0.88) is far
 *    from any real question (0.726 worst, so margin 0.094). It only ever catches
 *    something seen before — a brand-new slang phrase leaks once (that is what
 *    the "kaynaklar alakasız" button teaches).
 *
 * The recall numbers are optimistic (thresholds were chosen after seeing the
 * data); the precision numbers are the ones to trust. Do not lower a threshold
 * without re-running that validation.
 */

import { normalizeModelId } from './providers/model-caps';

/** The only embedding family the thresholds below were measured with. */
export const CALIBRATED_EMBEDDING_FAMILY = 'bge-m3';
export const CALIBRATED_EMBEDDING_DIMS = 1024;

/**
 * True when the configured embedding model is the one the gate was calibrated with. Matches the
 * normalized id (see normalizeModelId: `bge-m3:latest`, `BAAI/bge-m3`, `bge-m3-Q8_0.gguf`,
 * `C:/models/bge-m3-f16.gguf` all agree) as the family itself or the family followed by `-`
 * (quantization / tag suffix); other families (`bge-large`, `nomic-embed`, `qwen3-embedding`) and
 * `bge-m3` rerankers do not match. The dims must also be 1024 as a second guard.
 */
export function isGateCalibratedFor(model: string, dims: number): boolean {
	if (dims !== CALIBRATED_EMBEDDING_DIMS) return false;
	const n = normalizeModelId(model);
	if (n.includes('rerank')) return false;
	return n === CALIBRATED_EMBEDDING_FAMILY || n.startsWith(`${CALIBRATED_EMBEDDING_FAMILY}-`);
}

/** A seed match also needs the corpus to have nothing close to say: a message
 * whose nearest chunk is this near is probably a question about it. */
export const SEED_SIM = 0.78;
export const SEED_MIN_CORPUS_DIST = 0.45;
/** A phrase the user said or taught. */
export const PERSONAL_SIM = 0.82;
/** A message the user confirmed is a question ("Yine de kaynak ara") vetoes
 * anything this similar to it, whatever else matches. */
export const NEGATIVE_SIM = 0.85;
/** At or above this a message is "the same phrase" — not worth storing again. */
export const DUPLICATE_SIM = 0.95;

/**
 * The numbers decideSmallTalk and the store compare against. DEFAULT_THRESHOLDS are the bge-m3
 * measurements above (byte-identical to the constants); any other model gets thresholds derived
 * at runtime by smalltalk-calibration.ts. `seedMinCorpusDist: null` = the corpus-distance
 * condition is not applied (its 0.45 was measured with bge-m3's distance distribution only; a
 * derived seedSim already carries extra margin instead).
 */
export interface GateThresholds {
	seedSim: number;
	seedMinCorpusDist: number | null;
	personalSim: number;
	negativeSim: number;
	duplicateSim: number;
}
export const DEFAULT_THRESHOLDS: GateThresholds = {
	seedSim: SEED_SIM,
	seedMinCorpusDist: SEED_MIN_CORPUS_DIST,
	personalSim: PERSONAL_SIM,
	negativeSim: NEGATIVE_SIM,
	duplicateSim: DUPLICATE_SIM
};

export type PhraseSource = 'seed' | 'auto' | 'user';
export type PhraseKind = 'smalltalk' | 'question';

export interface GatePhrase {
	id: number;
	source: PhraseSource;
	kind: PhraseKind;
	/** The user reversed this phrase ("Yine de kaynak ara"): it no longer matches. */
	blocked: boolean;
	/** Unit length. */
	vec: Float32Array;
}

export interface GateDecision {
	smallTalk: boolean;
	/** Which rule flagged it. Learning only ever follows 'seed' (see the store). */
	via?: 'personal' | 'seed';
	/** The closest small-talk phrase considered, flagged or not. */
	phraseId?: number;
	phraseSource?: PhraseSource;
	/** Similarity to that closest phrase; -1 when there was none. */
	sim: number;
	/** A confirmed question vetoed a flag. */
	vetoed?: boolean;
}

export function normalize(v: ArrayLike<number>): Float32Array {
	const out = new Float32Array(v.length);
	let n = 0;
	for (let i = 0; i < v.length; i++) n += v[i] * v[i];
	n = Math.sqrt(n);
	if (n === 0) return out;
	for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
	return out;
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
	if (a.length !== b.length) return -1; // a stale vector from another embedding model never matches
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
}

/**
 * `query` is the vector retrieve() embedded for this turn (the last few user turns
 * joined, so "türev nedir | devam et" is judged as a whole and keeps its sources);
 * `corpusDist` is the nearest chunk's cosine distance (undefined when the KNN
 * returned nothing).
 */
export function decideSmallTalk(
	query: ArrayLike<number>,
	corpusDist: number | undefined,
	phrases: readonly GatePhrase[],
	t: GateThresholds = DEFAULT_THRESHOLDS
): GateDecision {
	const q = normalize(query);

	let negative = -1;
	let best: { id: number; source: PhraseSource; sim: number } | null = null;
	let bestSeed: { id: number; source: PhraseSource; sim: number } | null = null;
	for (const p of phrases) {
		const sim = dot(q, p.vec);
		if (p.kind === 'question') {
			if (sim > negative) negative = sim;
			continue;
		}
		if (p.blocked) continue;
		if (!best || sim > best.sim) best = { id: p.id, source: p.source, sim };
		if (p.source === 'seed' && (!bestSeed || sim > bestSeed.sim)) bestSeed = { id: p.id, source: p.source, sim };
	}

	const base = { sim: best?.sim ?? -1, phraseId: best?.id, phraseSource: best?.source };

	// A phrase the user or a seed matches at PERSONAL_SIM+ is "the same thing again";
	// a seed further away also needs the corpus to have nothing close.
	let via: 'personal' | 'seed' | undefined;
	if (best && best.sim >= t.personalSim) via = best.source === 'seed' ? 'seed' : 'personal';
	else if (bestSeed && bestSeed.sim >= t.seedSim && (t.seedMinCorpusDist === null || corpusDist === undefined || corpusDist >= t.seedMinCorpusDist)) via = 'seed';

	if (!via) return { smallTalk: false, ...base };
	if (negative >= t.negativeSim) return { smallTalk: false, vetoed: true, ...base };
	return { smallTalk: true, via, ...base };
}

/** `CHAT_SMALLTALK_GATE=0` (or off/false) switches the gate off — a kill switch for
 * a heuristic whose false positives silently drop grounding. Default on. */
export function smallTalkGateEnabled(raw: string | undefined): boolean {
	const v = raw?.trim().toLowerCase();
	return !(v === '0' || v === 'off' || v === 'false');
}
