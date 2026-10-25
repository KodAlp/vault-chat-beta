import { MEMORY_MAX_CHARS, MEMORY_MAX_NOTE_CHARS } from './memory-limits';

/**
 * Formats the memory block spliced into the chat system prompt (prompt.ts). Pure and dependency-free, like
 * learner-model.ts/learner-errors.ts: the caller (memory-store.ts) shapes plain data from the manual notes table
 * and from the already-computed, already-validated learner profile and weak-spot list — this module never
 * touches a database and never calls an LLM.
 *
 * Nothing here is inferred: manual notes are exactly what the user typed (STATED), and the derived lines are a
 * direct, templated read of numbers the learner model and weak-spot list already computed and measured on real data. No new judgment call is
 * made in this module.
 */

export interface MemoryBlockInput {
	/** Manual GLOBAL/PERSONAL notes, most recent first — kept whole (see MEMORY_MAX_NOTE_CHARS), never trimmed for
	 * budget before the derived content is. */
	notes: readonly { value: string }[];
	/** Domains with a reliable (F1b) mastery estimate below the "worth mentioning" threshold — the caller decides
	 * the threshold and which ones are reliable; this module only formats what it is given. */
	weakDomains: readonly { name: string; masteryPct: number }[];
	/** Notes with at least one open (unresolved) weak spot, most open errors first. */
	openWeakSpots: readonly { noteName: string; openErrors: number }[];
}

function trimmed(text: string, max: number): string {
	const t = text.trim();
	return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function derivedLines(input: MemoryBlockInput): string[] {
	const lines: string[] = [];
	if (input.weakDomains.length > 0) {
		lines.push(`Zayıf alanlar: ${input.weakDomains.map((d) => `${d.name} (~%${Math.round(d.masteryPct)})`).join(', ')}.`);
	}
	if (input.openWeakSpots.length > 0) {
		lines.push(`Üzerinde durulacaklar: ${input.openWeakSpots.map((s) => `${s.noteName} (${s.openErrors})`).join(', ')}.`);
	}
	return lines;
}

/** Formats the block, trimming derived content first (and, if still over budget, dropping the oldest notes) so a
 * user-written note is the last thing to be cut. Returns '' when there is nothing to say — no empty header. */
export function buildMemoryBlockText(input: MemoryBlockInput): string {
	const noteLines = input.notes.map((n) => `- ${trimmed(n.value, MEMORY_MAX_NOTE_CHARS)}`);
	let derived = derivedLines(input);

	const assemble = () => [...noteLines, ...derived].join('\n');
	let body = assemble();

	// derived content is computed, not user-authored: trim it first, one line at a time
	while (body.length > MEMORY_MAX_CHARS && derived.length > 0) {
		derived = derived.slice(0, -1);
		body = assemble();
	}
	// still over budget: drop the oldest notes (the end of the list) rather than truncate a note mid-sentence
	let notes = noteLines;
	while (body.length > MEMORY_MAX_CHARS && notes.length > 0) {
		notes = notes.slice(0, -1);
		body = [...notes, ...derived].join('\n');
	}

	return body ? `## Öğrenci hakkında bilgiler\n${body}` : '';
}
