/**
 * Offline judging support (#28): bench/run-generation.ts --dump-judge-prompts writes the judge prompts that are
 * missing from the cache, someone else (a Claude subagent) answers them, and bench/import-judgments.ts feeds the
 * raw responses back through the same validation callJudge uses, into the cache the judge phase already reads.
 */
import { parseJudgeResponse, type JudgeResult } from './judge';

export interface DumpedPrompt {
	key: string;
	id: string;
	numChunks: number;
	prompt: string;
}

export interface RawResponse {
	key: string;
	raw: string;
}

export interface ImportPlan {
	/** judge.jsonl lines to append (`{key, id, result}`), one per valid, not-yet-cached response. */
	lines: string[];
	ok: number;
	/** Responses that failed parseJudgeResponse, or whose key is not among the dumped prompts. */
	invalid: { key: string; id?: string; error: string }[];
	/** Dumped prompts that got no response at all. */
	missing: { key: string; id: string }[];
	/** Valid responses whose key is already cached; never overwritten. */
	alreadyCached: number;
}

export function parseJsonl<T>(text: string): T[] {
	const out: T[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as T);
		} catch {
			// a truncated line is reported as missing/invalid by the caller's counts
		}
	}
	return out;
}

export function planImport(prompts: DumpedPrompt[], responses: RawResponse[], existingKeys: Set<string>): ImportPlan {
	const byKey = new Map(prompts.map((p) => [p.key, p]));
	const plan: ImportPlan = { lines: [], ok: 0, invalid: [], missing: [], alreadyCached: 0 };
	const answered = new Set<string>();
	const written = new Set<string>();
	for (const r of responses) {
		const p = byKey.get(r.key);
		if (!p) {
			plan.invalid.push({ key: r.key, error: 'key not in --prompts' });
			continue;
		}
		answered.add(r.key);
		const v = parseJudgeResponse(typeof r.raw === 'string' ? r.raw : '', p.numChunks);
		if (!v.ok) {
			plan.invalid.push({ key: r.key, id: p.id, error: v.error });
			continue;
		}
		if (existingKeys.has(r.key) || written.has(r.key)) {
			plan.alreadyCached++;
			continue;
		}
		written.add(r.key);
		plan.ok++;
		plan.lines.push(JSON.stringify({ key: r.key, id: p.id, result: v.result satisfies JudgeResult }));
	}
	for (const p of prompts) if (!answered.has(p.key)) plan.missing.push({ key: p.key, id: p.id });
	return plan;
}
