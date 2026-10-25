import { computeLearnerProfile, computeWeakSpots } from './learner-store';
import { deriveMemorySignals } from './memory-runtime';
import { getDueCards } from './study-db';
import { buildReviewBlockText } from '../review-block';
import {
	REVIEW_MAX_DUE_CARDS,
	REVIEW_MAX_STALE_DOMAINS,
	REVIEW_SUGGEST_MAX_DUE_CARDS,
	REVIEW_SUGGEST_MIN_DUE_CARDS,
	REVIEW_SUGGEST_MIN_TOPICS,
	STALE_DOMAIN_DAYS
} from '../review-limits';
import type { LearnerProfile } from '../learner-model';
import { logAppEvent } from './app-log';
import type { VaultContext } from './vaults';

/**
 * REVIEW mode: the block spliced into the chat prompt (prompt.ts) when a chat's mode is 'review'. Reuses
 * computeLearnerProfile, computeWeakSpots and deriveMemorySignals exactly as they already are —
 * weak domains and open weak spots mean the same thing here as they do in the memory block, no second
 * definition. Only "long-unreviewed domains" (deriveStaleDomains below) and due cards are new for this mode.
 *
 * No LLM call, same discipline as the learner profile, weak spots and memory notes: the block is templated data, not a model-made judgment. The model
 * does the actual asking/grading in the conversation, as instructed by the block's text.
 */

const DAY_MS = 86_400_000;

/**
 * A domain with reliable mastery (so there IS an established number, not just noise) whose most recent answered
 * evidence (SkillNode.quiz.lastAt, F1b) is older than `thresholdDays`. A domain the person has never touched
 * is not "long-unreviewed" — it's simply not covered yet, a different thing REVIEW mode is not trying to say.
 * Pure and exported for testing, same split as memory-runtime.ts's deriveMemorySignals.
 */
export function deriveStaleDomains(profile: LearnerProfile, thresholdDays: number, now: Date): { name: string; daysSince: number }[] {
	return profile.nodes
		.filter((n) => n.kind === 'domain' && n.quiz.reliable && n.quiz.lastAt !== null)
		.map((n) => ({ name: n.name, daysSince: Math.floor((now.getTime() - Date.parse(n.quiz.lastAt!)) / DAY_MS) }))
		.filter((d) => d.daysSince >= thresholdDays)
		.sort((a, b) => b.daysSince - a.daysSince)
		.slice(0, REVIEW_MAX_STALE_DOMAINS);
}

/**
 * The REVIEW-mode block for a vault, right now. Fails soft — same posture as computeMemoryBlock/
 * smalltalk-runtime.ts: a failure here must degrade to no review block (the chat still works, just without the
 * agenda), never to an error in the user's answer. The caller (prompt.ts) only calls this when the chat's mode
 * is 'review' — an ordinary free_chat turn never reaches this function at all.
 */
export async function computeReviewBlock(v: VaultContext, now: Date = new Date()): Promise<string> {
	try {
		const profile = computeLearnerProfile(v, now);
		const weakSpots = computeWeakSpots(v);
		const { weakDomains, openWeakSpots } = deriveMemorySignals(profile, weakSpots);
		const staleDomains = deriveStaleDomains(profile, STALE_DOMAIN_DAYS, now);
		const dueCards = getDueCards(v, now.toISOString(), REVIEW_MAX_DUE_CARDS).map((c) => ({ front: c.front }));
		return buildReviewBlockText({ dueCards, weakDomains, openWeakSpots, staleDomains });
	} catch (err) {
		logAppEvent({ kind: 'review_error', message: err instanceof Error ? err.message : String(err) });
		return '';
	}
}

export interface ReviewSuggestion {
	suggest: boolean;
	dueCards: number;
	weakDomains: number;
	openWeakSpots: number;
	staleDomains: number;
}

/**
 * Pure: should the new-chat composer offer review mode? Decided ONLY from learning-state counts (the same inputs
 * computeReviewBlock feeds the block), never from anything the user typed, so it is language-independent.
 * Suggest when there is at least one due card, or at least one weak domain / open weak spot / stale domain.
 */
export function deriveReviewSuggestion(counts: { dueCards: number; weakDomains: number; openWeakSpots: number; staleDomains: number }): ReviewSuggestion {
	const topics = counts.weakDomains + counts.openWeakSpots + counts.staleDomains;
	return { ...counts, suggest: counts.dueCards >= REVIEW_SUGGEST_MIN_DUE_CARDS || topics >= REVIEW_SUGGEST_MIN_TOPICS };
}

/** Reads the learning state for the suggestion. Fails soft like computeReviewBlock: suggest:false, never throws. */
export function computeReviewSuggestion(v: VaultContext, now: Date = new Date()): ReviewSuggestion {
	try {
		const profile = computeLearnerProfile(v, now);
		const weakSpots = computeWeakSpots(v);
		const { weakDomains, openWeakSpots } = deriveMemorySignals(profile, weakSpots);
		const staleDomains = deriveStaleDomains(profile, STALE_DOMAIN_DAYS, now);
		const dueCards = getDueCards(v, now.toISOString(), REVIEW_SUGGEST_MAX_DUE_CARDS).length;
		return deriveReviewSuggestion({ dueCards, weakDomains: weakDomains.length, openWeakSpots: openWeakSpots.length, staleDomains: staleDomains.length });
	} catch (err) {
		logAppEvent({ kind: 'review_error', message: err instanceof Error ? err.message : String(err) });
		return { suggest: false, dueCards: 0, weakDomains: 0, openWeakSpots: 0, staleDomains: 0 };
	}
}
