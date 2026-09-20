/**
 * Recovery from corrupted model output, kept dependency-free (no SvelteKit
 * virtual modules, no DB) so it runs under plain `tsx --test` like
 * select-chunks.ts. The chat route (api/chat/+server.ts) owns the streaming
 * loop; this file owns the decisions.
 *
 * Background. qwen3 (Ollama) occasionally emits U+FFFD mid-stream, and a
 * Chinese character in a non-Chinese vault. Both used to throw the WHOLE
 * answer away and regenerate from scratch, however far along it was. The
 * alternative is to keep the clean text already shown to the user and ask the
 * model to continue from there.
 *
 * Verified against Ollama 0.32.5 / qwen3 (not assumed) before writing this:
 * - A trailing assistant message continues generation, but the model then
 *   treats that text as the inside of a <think> block: at the natural end of
 *   the answer it writes `</think>` and produces the whole answer AGAIN.
 *   Sending `stop: RESUME_STOP` ends the stream at that point.
 * - The prefix is re-tokenized, so a prefix cut mid-word (which is where a
 *   token boundary usually lands) gets read as a finished word ("yük" ->
 *   "yük taşıdığından" instead of "yükseklikte"). The seam technique below
 *   avoids that: prompt the model with the text up to the last whitespace and
 *   drop, from the start of what it writes, the part the user has already seen
 *   (the "tail"). With the app's real sampling this reproduced the tail 90% of
 *   the time on qwen3:8b Q4_K_M and 78% on IQ4_XS; when it does not, the caller
 *   falls back to the old restart, so recovery can never be worse than before.
 * - Ollama reuses the KV cache for the shared prefix: a ~2.9k-token continuation
 *   prefilled in 114 ms against 1870 ms cold.
 */

/** Resumes allowed per answer before falling back to a full restart. A resume
 * that hits the same corruption again would otherwise loop forever. */
export const MAX_RESUMES = 3;

/** Below this many kept characters a restart costs about the same as a resume
 * (a few seconds of generation), so the extra machinery is not worth it. */
export const MIN_RESUME_CHARS = 120;

/** Stop strings for a resume request. `</think>`/`<think>` end the stream where
 * the model would otherwise restart the answer inside a fake think block. The
 * template's own stops are repeated because a per-request `stop` list may
 * replace the Modelfile's rather than add to it. */
export const RESUME_STOP: readonly string[] = ['</think>', '<think>', '<|im_end|>', '<|im_start|>'];

const CJK_RANGE = /[一-鿿]/; // CJK Unified Ideographs, i.e. Chinese hanzi

/** Language names that make CJK Unified Ideographs an EXPECTED script rather
 * than a leak — e.g. a language-learning vault with allowedLanguages
 * ['Türkçe', 'Korece'] must never have its own Korean vocabulary flagged as
 * corruption. Substring-matched, case-insensitive, against
 * LibrarySettings.allowedLanguages — deliberately a plain list, not a rigid
 * enum, so covering another spelling/language is a one-line addition. */
const CJK_LANGUAGE_NAMES = [
	'çince',
	'chinese',
	'mandarin',
	'中文',
	'japonca',
	'japanese',
	'日本語',
	'korece',
	'korean',
	'한국어'
];

export function isCjkExpected(allowedLanguages: string[]): boolean {
	return allowedLanguages.some((lang) => {
		const lower = lang.toLowerCase();
		return CJK_LANGUAGE_NAMES.some((name) => lower.includes(name));
	});
}

export type CorruptionKind = 'fffd' | 'cjk';

export interface Corruption {
	/** UTF-16 offset of the first offending character in the inspected text. */
	index: number;
	kind: CorruptionKind;
}

/** The first corrupted character in `text`, or null when it is clean. Two
 * reasons count: a literal U+FFFD, or a CJK character in a vault whose
 * allowedLanguages does not expect one. */
export function findCorruption(text: string, allowedLanguages: string[]): Corruption | null {
	const fffd = text.indexOf('�');
	let cjk = -1;
	if (!isCjkExpected(allowedLanguages)) {
		const m = CJK_RANGE.exec(text);
		if (m) cjk = m.index;
	}
	if (fffd < 0 && cjk < 0) return null;
	if (fffd >= 0 && (cjk < 0 || fffd <= cjk)) return { index: fffd, kind: 'fffd' };
	return { index: cjk, kind: 'cjk' };
}

export function isCorruptedChunk(text: string, allowedLanguages: string[]): boolean {
	return findCorruption(text, allowedLanguages) !== null;
}

export interface SeamPlan {
	/** What to hand the model as the assistant's partial answer: the displayed
	 * text with the trailing partial word (and whitespace) removed. */
	prompt: string;
	/** What the user has already seen beyond `prompt`: the whitespace run plus
	 * the partial word. The model's continuation is expected to start with it. */
	tail: string;
}

/** Cuts `displayed` back to the last whitespace boundary. Null when there is no
 * usable boundary (one unbroken word) — the caller restarts instead. */
export function planSeam(displayed: string): SeamPlan | null {
	const trimmedEnd = displayed.replace(/\s+$/, '');
	if (trimmedEnd.length !== displayed.length) {
		// Already ends on whitespace: the whole answer so far is a finished prefix.
		return trimmedEnd.length > 0 ? { prompt: trimmedEnd, tail: displayed.slice(trimmedEnd.length) } : null;
	}
	const last = Math.max(displayed.lastIndexOf(' '), displayed.lastIndexOf('\n'), displayed.lastIndexOf('\t'));
	if (last <= 0) return null;
	let start = last;
	while (start > 0 && /\s/.test(displayed[start - 1])) start--;
	return start > 0 ? { prompt: displayed.slice(0, start), tail: displayed.slice(start) } : null;
}

export type RestartReason =
	| 'reasoning'
	| 'think-mode'
	| 'has-thinking'
	| 'tool-round-trips'
	| 'tool-call'
	| 'unsupported'
	| 'resume-limit'
	| 'too-short'
	| 'no-seam';

export interface RecoveryState {
	/** Which stream the corrupted chunk arrived on. Only visible text resumes. */
	where: 'text' | 'reasoning';
	/** The user asked for think mode — resume semantics were not verified with it. */
	thinkRequested: boolean;
	/** Reasoning text was already produced in this answer. */
	hasThinking: boolean;
	toolRoundTrips: number;
	/** The current hop already collected a tool call. */
	hopHadToolCall: boolean;
	resumesUsed: number;
	/** The clean text that would be kept: everything shown so far plus the
	 * clean part of the corrupted chunk. */
	displayed: string;
	/** Whether the provider/model pair was verified to continue from a trailing
	 * assistant message (registry.supportsPrefixResume). */
	supportsResume: boolean;
}

export type RecoveryPlan = { action: 'resume'; seam: SeamPlan } | { action: 'restart'; reason: RestartReason };

/** Resume only in the one situation that was verified; every other case keeps
 * the previous behaviour (throw the attempt away and regenerate). */
export function planRecovery(s: RecoveryState): RecoveryPlan {
	if (s.where === 'reasoning') return { action: 'restart', reason: 'reasoning' };
	if (s.thinkRequested) return { action: 'restart', reason: 'think-mode' };
	if (s.hasThinking) return { action: 'restart', reason: 'has-thinking' };
	if (s.toolRoundTrips > 0) return { action: 'restart', reason: 'tool-round-trips' };
	if (s.hopHadToolCall) return { action: 'restart', reason: 'tool-call' };
	if (!s.supportsResume) return { action: 'restart', reason: 'unsupported' };
	if (s.resumesUsed >= MAX_RESUMES) return { action: 'restart', reason: 'resume-limit' };
	if (s.displayed.length < MIN_RESUME_CHARS) return { action: 'restart', reason: 'too-short' };
	const seam = planSeam(s.displayed);
	if (!seam) return { action: 'restart', reason: 'no-seam' };
	return { action: 'resume', seam };
}

/** A resumed stream whose first words did not line up with what the user had
 * seen is worth trying again before giving up: nothing was shown, the attempt
 * costs a fraction of a second (the KV cache already holds the prefix), and the
 * model samples afresh each time. Measured against a real qwen3 through the
 * route, ~1 in 3 first tries missed the seam; a second and third try make a full
 * restart rare. Shares MAX_RESUMES with real corruptions so the total stays bounded. */
export function canRetryResume(resumesUsed: number): boolean {
	return resumesUsed < MAX_RESUMES;
}

export type SeamStatus = 'pending' | 'ok' | 'mismatch';

export interface SeamTrimmer {
	/** Feed the model's next text chunk. `emit` is what to show the user
	 * (empty while `pending`, and always empty on `mismatch`). */
	push(chunk: string): { status: SeamStatus; emit: string };
	/** The stream ended. A tail that was only whitespace is fine (the model had
	 * nothing more to add); a partial word that never got reproduced is not. */
	finish(): { status: 'ok' | 'mismatch'; emit: string };
}

/**
 * Removes from the start of a resumed stream the part the user has already
 * seen. For a whitespace-only tail, any leading whitespace the model writes is
 * dropped (it would double the space or newline the user already has). For a
 * partial-word tail, the model must reproduce it exactly; if its first
 * characters disagree it took a different path and the seam is unusable.
 */
export function createSeamTrimmer(tail: string): SeamTrimmer {
	const whitespaceTail = /^\s*$/.test(tail);
	let buffer = '';
	let decided: 'ok' | 'mismatch' | null = null;

	return {
		push(chunk) {
			if (decided === 'ok') return { status: 'ok', emit: chunk };
			if (decided === 'mismatch') return { status: 'mismatch', emit: '' };
			buffer += chunk;

			if (whitespaceTail) {
				const rest = buffer.replace(/^\s+/, '');
				if (rest === '') return { status: 'pending', emit: '' };
				decided = 'ok';
				buffer = '';
				return { status: 'ok', emit: rest };
			}

			if (buffer.length >= tail.length) {
				if (buffer.startsWith(tail)) {
					decided = 'ok';
					const rest = buffer.slice(tail.length);
					buffer = '';
					return { status: 'ok', emit: rest };
				}
				decided = 'mismatch';
				return { status: 'mismatch', emit: '' };
			}
			if (tail.startsWith(buffer)) return { status: 'pending', emit: '' };
			decided = 'mismatch';
			return { status: 'mismatch', emit: '' };
		},
		finish() {
			if (decided === 'ok') return { status: 'ok', emit: '' };
			if (decided === 'mismatch') return { status: 'mismatch', emit: '' };
			return whitespaceTail ? { status: 'ok', emit: '' } : { status: 'mismatch', emit: '' };
		}
	};
}
