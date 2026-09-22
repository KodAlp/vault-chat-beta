import { computeLearnerProfile, computeWeakSpots } from './learner-store';
import { deriveMemorySignals } from './memory-runtime';
import { getDueCards } from './study-db';
import { buildReviewBlockText } from '../review-block';
import { REVIEW_MAX_DUE_CARDS, REVIEW_MAX_STALE_DOMAINS, STALE_DOMAIN_DAYS } from '../review-limits';
import type { LearnerProfile } from '../learner-model';
import { logAppEvent } from './app-log';
import type { VaultContext } from './vaults';

/**
 * F6 — REVIEW mode: the block spliced into the chat prompt (prompt.ts) when a chat's mode is 'review'. Reuses
 * F1b (computeLearnerProfile), F2 (computeWeakSpots) and F3's deriveMemorySignals exactly as they already are —
 * weak domains and open weak spots mean the same thing here as they do in the memory block, no second
 * definition. Only "long-unreviewed domains" (deriveStaleDomains below) and due cards are new for this mode.
 *
 * No LLM call, same discipline as F1b/F2/F3: the block is templated data, not a model-made judgment. The model
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
