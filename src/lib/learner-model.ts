import { isCognitiveLevel, type CognitiveLevel } from './cognitive-levels';

/**
 * The learner model (F1b): what the quiz answers and the card reviews say about how well a person knows each domain and note.
 * Pure and dependency-free (client-safe types + the arithmetic), so every number on the progress page can be checked in a test.
 *
 * Design decisions, each of them a measurement or a stated limit and not a taste:
 *  - No cognitive-level axes by default. Level labels are opt-in and, on a small local model, only the coarse split
 *    (remember/explain vs apply/analyse, about 80% agreement with an independent check) was trustworthy, so the labels feed a
 *    two-band breakdown ("basic" / "applied") that appears only for questions that carry a level.
 *  - Mastery is an estimate with a stated confidence, never a bare score. With no evidence it is `null`, not 0.5; with too
 *    little evidence it is returned but flagged unreliable so a page can say "not enough data" instead of a number.
 *  - Quiz answers and card reviews are kept apart: `mastery` says how the person did on questions, `retention` says how likely
 *    they are to remember the cards now. Blending a probability and a right/wrong count would make both unreadable.
 */

export type EvidenceType = 'multiple_choice' | 'true_false' | 'open';

/** One counted answer: the latest answered attempt of one distinct question (learner-evidence.ts decides which). */
export interface EvidencePoint {
	/** Identity of the question: source part + normalised text, so the same question stored twice is one question. */
	key: string;
	sourcePath: string;
	/** Domains of the note the question came from (from the index); empty when the note is not in the index. */
	domains: string[];
	type: EvidenceType;
	correct: boolean;
	/** ISO time of the answer. */
	at: string;
	/** The level the question was written for, when the experimental labels were on; null for every other question. */
	level: CognitiveLevel | null;
}

/** What is known about one flash card's schedule (the cards table has no "last reviewed" column; it is derived). */
export interface CardPoint {
	sourcePath: string;
	domains: string[];
	intervalDays: number;
	dueAt: string;
	reps: number;
	lapses: number;
}

/** Older answers say less about what a person knows today: half the weight every 45 days. */
export const HALF_LIFE_DAYS = 45;

/**
 * Chance of being right by luck, per question type. A true/false answer is right half the time by guessing, a five-option
 * multiple-choice one a fifth of the time, an open answer practically never. The weight of an answer is 1 - this, so one
 * right true/false answer says half as much as one right open answer.
 */
export const GUESS_RATE: Record<EvidenceType, number> = { true_false: 0.5, multiple_choice: 0.2, open: 0 };

/** Below this much (decayed, guess-adjusted) evidence a number is not shown as a fact. Roughly three right open answers. */
export const MIN_RELIABLE_WEIGHT = 3;
/** From here on the estimate is called high-confidence. */
export const HIGH_CONFIDENCE_WEIGHT = 8;
/** Cards a node needs before its retention is shown as a number. */
export const MIN_RELIABLE_CARDS = 3;

const DAY_MS = 86_400_000;

export type Confidence = 'none' | 'insufficient' | 'moderate' | 'high';

export interface MasteryEstimate {
	/** In [0, 1], or null when there is no evidence at all. May be present but not `reliable`. */
	mastery: number | null;
	/** How many distinct questions were counted. */
	count: number;
	/** Sum of the decayed, guess-adjusted weights: the "amount" of evidence. */
	weight: number;
	confidence: Confidence;
	/** True from `moderate` on: the number is safe to show as a number. */
	reliable: boolean;
	/** ISO time of the newest counted answer. */
	lastAt: string | null;
}

export interface RetentionEstimate {
	/** Mean chance of remembering a reviewed card right now, in [0, 1], or null when no card has been reviewed. */
	retention: number | null;
	/** Reviewed cards counted. */
	cards: number;
	reliable: boolean;
}

export type Band = 'basic' | 'applied';

/** The coarse split the labels support: remember/explain versus apply/analyse. */
export function bandOf(level: CognitiveLevel): Band {
	return level === 'application' || level === 'higher' ? 'applied' : 'basic';
}

function ageDays(iso: string, now: Date): number {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return 0;
	return Math.max(0, (now.getTime() - t) / DAY_MS);
}

/** Decay times guess-adjustment. Always in (0, 1]. */
export function evidenceWeight(point: Pick<EvidencePoint, 'type' | 'at'>, now: Date): number {
	return Math.pow(0.5, ageDays(point.at, now) / HALF_LIFE_DAYS) * (1 - GUESS_RATE[point.type]);
}

function confidenceOf(count: number, weight: number): Confidence {
	if (count === 0) return 'none';
	if (weight < MIN_RELIABLE_WEIGHT) return 'insufficient';
	return weight < HIGH_CONFIDENCE_WEIGHT ? 'moderate' : 'high';
}

/**
 * (sum(w * correct) + 1) / (sum(w) + 2): the mean of a Beta(1, 1) prior updated with weighted right/wrong answers. One right answer
 * does not read as 100%, and the number moves toward what the person really does as evidence accumulates.
 */
export function masteryOf(points: readonly EvidencePoint[], now: Date): MasteryEstimate {
	if (points.length === 0) return { mastery: null, count: 0, weight: 0, confidence: 'none', reliable: false, lastAt: null };
	let weight = 0;
	let right = 0;
	let lastAt: string | null = null;
	let lastMs = -Infinity;
	for (const p of points) {
		const w = evidenceWeight(p, now);
		weight += w;
		if (p.correct) right += w;
		const ms = Date.parse(p.at);
		if (!Number.isNaN(ms) && ms > lastMs) {
			lastMs = ms;
			lastAt = p.at;
		}
	}
	const confidence = confidenceOf(points.length, weight);
	return { mastery: (right + 1) / (weight + 2), count: points.length, weight, confidence, reliable: confidence === 'moderate' || confidence === 'high', lastAt };
}

/**
 * Chance of remembering a reviewed card now: 0.9 at the day it is due, decaying by the scheduled interval (the usual
 * definition of retrievability for a spaced-repetition schedule). A card never reviewed (no reps, no lapses) has no
 * retention; a card whose last answer was "again" (interval 0) is forgotten until it is reviewed again.
 * The last review is not stored, but the schedule writes `due_at = reviewed_at + interval`, so it is due_at minus the interval.
 */
export function cardRetention(card: CardPoint, now: Date): number | null {
	if (card.reps <= 0 && card.lapses <= 0) return null;
	if (card.intervalDays <= 0) return 0;
	const due = Date.parse(card.dueAt);
	if (Number.isNaN(due)) return null;
	const reviewedAt = due - card.intervalDays * DAY_MS;
	const elapsed = Math.max(0, (now.getTime() - reviewedAt) / DAY_MS);
	return Math.pow(0.9, elapsed / card.intervalDays);
}

export function retentionOf(cards: readonly CardPoint[], now: Date): RetentionEstimate {
	const values = cards.map((c) => cardRetention(c, now)).filter((r): r is number => r !== null);
	if (values.length === 0) return { retention: null, cards: 0, reliable: false };
	return { retention: values.reduce((a, b) => a + b, 0) / values.length, cards: values.length, reliable: values.length >= MIN_RELIABLE_CARDS };
}

export interface SkillNode {
	id: string;
	kind: 'overall' | 'domain' | 'note';
	name: string;
	/** Notes only: the source part's file path and the domains it belongs to (a note can be in several). */
	sourcePath?: string;
	domains?: string[];
	quiz: MasteryEstimate;
	/** The basic/applied split, or null when no counted question carries a level (the labels are off by default). */
	bands: Record<Band, MasteryEstimate> | null;
	retention: RetentionEstimate;
}

export interface LearnerProfile {
	generatedAt: string;
	nodes: SkillNode[];
}

/** Domain used for a note the index does not know (deleted or renamed since the quiz). */
export const UNKNOWN_DOMAIN = '(unknown)';

function noteName(path: string): string {
	return (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
}

function nodeFor(id: string, kind: SkillNode['kind'], name: string, points: readonly EvidencePoint[], cards: readonly CardPoint[], now: Date, extra: Partial<SkillNode> = {}): SkillNode {
	const labelled = points.filter((p) => p.level !== null && isCognitiveLevel(p.level));
	return {
		id,
		kind,
		name,
		...extra,
		quiz: masteryOf(points, now),
		bands: labelled.length === 0 ? null : { basic: masteryOf(labelled.filter((p) => bandOf(p.level!) === 'basic'), now), applied: masteryOf(labelled.filter((p) => bandOf(p.level!) === 'applied'), now) },
		retention: retentionOf(cards, now)
	};
}

/**
 * The skill tree as a flat list: one `overall` node, one `domain` node per domain that has evidence or cards, one `note` node per
 * note that has any. A question counts once in `overall` even when its note belongs to several domains; each of those domains
 * counts it, since it says something about each.
 */
export function buildProfile(input: { points: readonly EvidencePoint[]; cards: readonly CardPoint[]; now?: Date }): LearnerProfile {
	const now = input.now ?? new Date();
	const domainsOf = (d: readonly string[]) => (d.length > 0 ? d : [UNKNOWN_DOMAIN]);
	const nodes: SkillNode[] = [nodeFor('overall', 'overall', 'overall', input.points, input.cards, now)];

	const domains = new Set<string>();
	for (const p of input.points) for (const d of domainsOf(p.domains)) domains.add(d);
	for (const c of input.cards) for (const d of domainsOf(c.domains)) domains.add(d);
	const domainNodes = [...domains].map((d) =>
		nodeFor(`domain:${d}`, 'domain', d, input.points.filter((p) => domainsOf(p.domains).includes(d)), input.cards.filter((c) => domainsOf(c.domains).includes(d)), now)
	);
	// most evidence first: that is where the numbers mean something
	domainNodes.sort((a, b) => b.quiz.count + b.retention.cards - (a.quiz.count + a.retention.cards) || a.name.localeCompare(b.name));
	nodes.push(...domainNodes);

	const paths = new Set<string>([...input.points.map((p) => p.sourcePath), ...input.cards.map((c) => c.sourcePath)]);
	const noteNodes = [...paths].map((path) => {
		const pts = input.points.filter((p) => p.sourcePath === path);
		const crds = input.cards.filter((c) => c.sourcePath === path);
		const doms = [...new Set([...pts.flatMap((p) => p.domains), ...crds.flatMap((c) => c.domains)])];
		return nodeFor(`note:${path}`, 'note', noteName(path), pts, crds, now, { sourcePath: path, domains: doms });
	});
	noteNodes.sort((a, b) => b.quiz.count + b.retention.cards - (a.quiz.count + a.retention.cards) || a.name.localeCompare(b.name));
	nodes.push(...noteNodes);

	return { generatedAt: now.toISOString(), nodes };
}
