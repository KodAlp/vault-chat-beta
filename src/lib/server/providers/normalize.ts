import type { Chunk } from './types';

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** Longest suffix of `s` that is also a (proper) prefix of `marker` — the
 * part of `s` that could still turn into `marker` once more text arrives. */
function overlapLength(s: string, marker: string): number {
	const max = Math.min(s.length, marker.length - 1);
	for (let len = max; len > 0; len--) {
		if (s.endsWith(marker.slice(0, len))) return len;
	}
	return 0;
}

export interface ThinkTagNormalizer {
	feed(rawText: string): Chunk[];
	/** Call once at stream end — flushes whatever's left in the buffer
	 * (even a dangling, never-completed partial tag) as text. */
	flush(): Chunk[];
}

/**
 * Ollama's OpenAI-compatible endpoint (unlike its native /api/chat, which
 * splits reasoning into a separate structured field) inlines reasoning as
 * literal <think>...</think> markers in the content stream. Tags can split
 * across chunk boundaries ("<th" + "ink>") — the exact failure class behind
 * the original ThinkingPanel bugs — so this buffers any tail that's still an
 * unresolved prefix of the marker it's currently watching for, and only
 * ever emits chunks for text it's actually sure about.
 */
export function createThinkTagNormalizer(): ThinkTagNormalizer {
	let mode: 'text' | 'thinking' = 'text';
	let buffer = '';

	function feed(rawText: string): Chunk[] {
		let s = buffer + rawText;
		buffer = '';
		const out: Chunk[] = [];

		for (;;) {
			const marker = mode === 'text' ? THINK_OPEN : THINK_CLOSE;
			const idx = s.indexOf(marker);
			if (idx === -1) {
				const overlap = overlapLength(s, marker);
				const safe = s.slice(0, s.length - overlap);
				buffer = s.slice(s.length - overlap);
				if (safe) out.push({ type: mode === 'text' ? 'text' : 'reasoning', text: safe });
				return out;
			}
			const before = s.slice(0, idx);
			if (before) out.push({ type: mode === 'text' ? 'text' : 'reasoning', text: before });
			mode = mode === 'text' ? 'thinking' : 'text';
			s = s.slice(idx + marker.length);
		}
	}

	function flush(): Chunk[] {
		const out: Chunk[] = [];
		if (buffer) out.push({ type: mode === 'text' ? 'text' : 'reasoning', text: buffer });
		buffer = '';
		return out;
	}

	return { feed, flush };
}

/** reasoning_content dialect (DeepSeek etc.): reasoning arrives as its own
 * delta field already — trivial passthrough, no buffering needed. */
export function reasoningContentChunk(text: string): Chunk {
	return { type: 'reasoning', text };
}

export function textChunk(text: string): Chunk {
	return { type: 'text', text };
}
