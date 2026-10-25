import { getChatsDb } from './chats-db';
import { addMemoryNote, deleteMemoryNote, editMemoryNote, listLiveMemoryNotes, memoryGateEnabled, type MemoryRow, type MemoryType } from './memory-store';
import { computeLearnerProfile, computeWeakSpots } from './learner-store';
import type { WeakSpot } from './learner-errors';
import { buildMemoryBlockText, type MemoryBlockInput } from '../memory-block';
import type { LearnerProfile } from '../learner-model';
import { logAppEvent } from './app-log';
import type { VaultContext } from './vaults';

/**
 * The glue between chats.db (manual notes), the vault's already-computed learner data (learner profile and weak spots), and the
 * pure formatter (memory-block.ts). Separate from memory-store.ts on purpose: memory-store.ts must not import
 * chats-db.ts, because chats-db.ts imports memory-store.ts (for initMemorySchema) — putting getChatsDb() here
 * instead avoids that cycle, the same reason smalltalk-runtime.ts exists apart from smalltalk-store.ts.
 *
 * The API routes use the thin wrappers below (listMemory/addMemory/editMemory/deleteMemory); prompt.ts uses only
 * computeMemoryBlock.
 */

export function listMemory(): MemoryRow[] {
	return listLiveMemoryNotes(getChatsDb());
}

export function addMemory(input: { type: MemoryType; domain?: string | null; value: string }): MemoryRow {
	return addMemoryNote(getChatsDb(), input);
}

export function editMemory(id: string, value: string): MemoryRow | null {
	return editMemoryNote(getChatsDb(), id, value);
}

export function deleteMemory(id: string): boolean {
	return deleteMemoryNote(getChatsDb(), id);
}

/** A domain's F1b mastery is "worth mentioning" below this — deliberately the same rough cut as "needs a look",
 * not tuned against real data yet (see memory-limits.ts's budget: same "picked, not measured" caveat). */
const WEAK_DOMAIN_MASTERY = 0.6;
const MAX_WEAK_DOMAINS = 3;
const MAX_OPEN_WEAK_SPOTS = 3;

/**
 * Picks and shapes the derived (never stored) part of the memory block out of the learner profile and the weak-spot list's
 * weak-spot list — both already computed and already validated elsewhere, so this is templating, not a new
 * judgment call. Pure (plain in, plain out), separated from computeMemoryBlock so it can be tested with fabricated
 * profiles/weak-spot lists instead of a real vault + chats.db singleton.
 */
export function deriveMemorySignals(profile: LearnerProfile, weakSpots: readonly WeakSpot[]): Pick<MemoryBlockInput, 'weakDomains' | 'openWeakSpots'> {
	const weakDomains = profile.nodes
		.filter((n) => n.kind === 'domain' && n.quiz.reliable && n.quiz.mastery !== null && n.quiz.mastery < WEAK_DOMAIN_MASTERY)
		.sort((a, b) => a.quiz.mastery! - b.quiz.mastery!)
		.slice(0, MAX_WEAK_DOMAINS)
		.map((n) => ({ name: n.name, masteryPct: n.quiz.mastery! * 100 }));

	const openWeakSpots = weakSpots
		.filter((s) => s.openErrors > 0)
		.slice(0, MAX_OPEN_WEAK_SPOTS)
		.map((s) => ({ noteName: s.noteName, openErrors: s.openErrors }));

	return { weakDomains, openWeakSpots };
}

/**
 * The memory block spliced into the chat system prompt (prompt.ts). Fails soft — same posture as
 * smalltalk-runtime.ts's documented rule: a failure here must degrade to no memory block, never to an error in
 * the user's answer. Returns '' when the gate is off, when there is nothing to say, or on any error.
 */
export async function computeMemoryBlock(v: VaultContext): Promise<string> {
	if (!memoryGateEnabled(process.env.CHAT_MEMORY_GATE)) return '';
	try {
		const notes = listMemory().map((n) => ({ value: n.value }));
		const { weakDomains, openWeakSpots } = deriveMemorySignals(computeLearnerProfile(v), computeWeakSpots(v));
		return buildMemoryBlockText({ notes, weakDomains, openWeakSpots });
	} catch (err) {
		logAppEvent({ kind: 'memory_error', message: err instanceof Error ? err.message : String(err) });
		return '';
	}
}
