/**
 * Two output failures of qwen3 that the chat route repairs while streaming,
 * kept dependency-free (no SvelteKit virtual modules) like resume-plan.ts so
 * they run under plain `tsx --test`.
 *
 * 1. Repetition loops: the model repeats a paragraph (period 50-1500 chars) or
 *    a short unit ("候选者候选者候选者...") until the token cap, leaving 12-14k
 *    chars of garbage. findRepetitionLoop recognises it from the tail of the
 *    text and says where to cut so that exactly one copy survives.
 * 2. A stray `</think>` in visible text: with thinking off the model sometimes
 *    writes its reasoning (or a loop) as plain answer text, then a literal
 *    `</think>` line, then the real answer. findStrayThinkClose finds that line.
 */

export interface RepetitionLoop {
	/** Keep `text.slice(0, cutAt)` (the caller trims the end). */
	cutAt: number;
}

/**
 * A loop is present when the last `tail` characters of the text occur at least
 * `minOccurrences` times in it (overlapping occurrences count, so a short unit
 * repeated many times matches too). Normal answers repeat short headings, not
 * 200 identical characters, so they do not match.
 */
export function findRepetitionLoop(
	text: string,
	opts: { tail?: number; minOccurrences?: number } = {}
): RepetitionLoop | null {
	const tail = opts.tail ?? 200;
	const minOccurrences = opts.minOccurrences ?? 3;
	if (text.length < tail) return null;
	const t = text.slice(text.length - tail);
	if (t.trim().length < tail / 2) return null;

	const starts: number[] = [];
	let from = 0;
	while (starts.length < minOccurrences) {
		const i = text.indexOf(t, from);
		if (i < 0) break;
		starts.push(i);
		from = i + 1;
	}
	if (starts.length < minOccurrences) return null;

	const o1 = starts[0];
	const o2 = starts[1];
	const p = o2 - o1;
	let cutAt: number;
	if (text.slice(o1, o2) === text.slice(o2, o2 + p)) {
		// Periodic: walk back to where the repetition started and keep one copy.
		let s = o1;
		while (s > 0 && text[s - 1] === text[s - 1 + p]) s--;
		cutAt = s + p;
	} else {
		// Not a clean period (e.g. sections that each begin with the same long
		// sentence): drop only the last occurrence.
		cutAt = text.length - tail;
	}

	// Do not split a word: if the cut lands inside one, back up to the whitespace
	// before it. Text without word breaks (CJK) keeps the exact cut, so the search
	// is bounded rather than walking back to the start of the answer.
	if (cutAt > 0 && cutAt < text.length && !/\s/.test(text[cutAt]) && !/\s/.test(text[cutAt - 1])) {
		const limit = Math.max(0, cutAt - 40);
		for (let i = cutAt - 1; i >= limit; i--) {
			if (/\s/.test(text[i])) {
				cutAt = i;
				break;
			}
		}
	}
	return { cutAt: Math.max(0, cutAt) };
}

const THINK_CLOSE = '</think>';
const THINK_OPEN = '<think>';
const LINE_START_CLOSE = /(^|\n)[ \t]*<\/think>/;

/**
 * Index of a `</think>` that opens a line (optional spaces/tabs before it) and
 * has no `<think>` anywhere before it, so it cannot belong to a real think
 * block; -1 otherwise. Inline mentions ("use </think> tags") do not count.
 */
export function findStrayThinkClose(text: string): number {
	if (!text.includes(THINK_CLOSE)) return -1;
	const m = LINE_START_CLOSE.exec(text);
	if (!m) return -1;
	const idx = m.index + m[0].length - THINK_CLOSE.length;
	return text.lastIndexOf(THINK_OPEN, idx) >= 0 ? -1 : idx;
}

/** A cut can land inside a fenced code block; close it so the rest of the
 * message does not render as code. */
export function closeOpenFence(text: string): string {
	const fences = text.match(/^[ 	]*```/gm)?.length ?? 0;
	return fences % 2 === 1 ? text + '\n```' : text;
}
