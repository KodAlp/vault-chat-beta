import type { Chunk } from './types';

export type UsageChunk = Extract<Chunk, { type: 'usage' }>;

/** The fields of Ollama's final `/api/chat` NDJSON line (`done: true`) this
 * app reads. Durations are nanoseconds. Deliberately no `prompt_eval_cached_count`:
 * Ollama 0.32.5's final line does not carry one (verified against a live
 * response — see docs/plan-ogrenme-ajani-ve-performans.md §3). */
export interface OllamaDoneLine {
	done?: boolean;
	prompt_eval_count?: number;
	prompt_eval_duration?: number;
	eval_count?: number;
	eval_duration?: number;
	load_duration?: number;
}

/** A request whose prompt + completion fill this share of `num_ctx` or more
 * is one Ollama is likely to have truncated from the front (where the system
 * prompt's rules live) or context-shifted. Reported, never acted on here. */
export const NEAR_CTX_LIMIT = 0.9;

const NS_PER_MS = 1e6;

function ms(ns: unknown): number | undefined {
	return typeof ns === 'number' && Number.isFinite(ns) ? Math.round(ns / NS_PER_MS) : undefined;
}

function count(n: unknown): number | undefined {
	return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Turns Ollama's final stream line into a `usage` chunk. Returns null for any
 * line that is not the final one, and for a final line that carries neither
 * token count — a chunk of zeros would read as a real measurement. */
export function parseOllamaDone(line: OllamaDoneLine, numCtx: number): UsageChunk | null {
	if (!line.done) return null;
	const prompt = count(line.prompt_eval_count);
	const completion = count(line.eval_count);
	if (prompt === undefined && completion === undefined) return null;

	const usage: UsageChunk = { type: 'usage', prompt: prompt ?? 0, completion: completion ?? 0, numCtx };
	const promptMs = ms(line.prompt_eval_duration);
	const completionMs = ms(line.eval_duration);
	const loadMs = ms(line.load_duration);
	if (promptMs !== undefined) usage.promptMs = promptMs;
	if (completionMs !== undefined) usage.completionMs = completionMs;
	if (loadMs !== undefined) usage.loadMs = loadMs;
	return usage;
}

/** Share of the context window this request used, or undefined when the
 * window size is unknown. */
export function ctxFill(usage: UsageChunk): number | undefined {
	if (!usage.numCtx || usage.numCtx <= 0) return undefined;
	return (usage.prompt + usage.completion) / usage.numCtx;
}

export function isNearCtxLimit(usage: UsageChunk): boolean {
	const fill = ctxFill(usage);
	return fill !== undefined && fill >= NEAR_CTX_LIMIT;
}
