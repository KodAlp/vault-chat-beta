import { AppError } from './app-error';
import type { ErrorCode } from '../errors';

/**
 * Contract of `ingest/formula_repair.py` (one JSON line on stdout): see formula-repair-run.ts for how
 * it is spawned. Kept free of process/kit imports so the parsing is unit-testable.
 */
export interface RepairCandidate {
	latex: string;
	source: string;
	/** Whether the real KaTeX renders it; null = not checked. */
	katexOk: boolean | null;
}

export interface RepairResult {
	page: number;
	bbox: [number, number, number, number] | null;
	bboxSource: 'marker' | 'match' | 'none';
	candidates: RepairCandidate[];
}

const FAIL_CODES: Record<string, ErrorCode> = {
	NO_CUDA: 'FORMULA_REPAIR_NO_CUDA',
	PDF_OPEN_FAILED: 'PDF_DAMAGED',
	PAGE_OUT_OF_RANGE: 'FORMULA_REPAIR_BAD_PAGE',
	NO_BOX: 'FORMULA_REPAIR_NO_BOX',
	MODEL_MISSING: 'FORMULA_REPAIR_MODEL_MISSING'
};

/** The last stdout line that is a JSON object (libraries may print noise before it). */
function lastJsonObject(stdout: string): Record<string, unknown> | null {
	const lines = stdout.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line.startsWith('{')) continue;
		try {
			const value = JSON.parse(line);
			if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
		} catch {
			// not the result line
		}
	}
	return null;
}

function bboxOf(value: unknown): [number, number, number, number] | null {
	if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
	return value as [number, number, number, number];
}

/** Parses the CLI's stdout into a result, or throws an AppError with the mapped code. */
export function parseRepairOutput(stdout: string, stderrTail = ''): RepairResult {
	const out = lastJsonObject(stdout);
	if (!out) throw new AppError('FORMULA_REPAIR_FAILED', { detail: stderrTail.slice(-300) || 'no output' });
	if (out.ok !== true) {
		const code = typeof out.code === 'string' ? out.code : '';
		const mapped = FAIL_CODES[code];
		if (mapped) throw new AppError(mapped);
		throw new AppError('FORMULA_REPAIR_FAILED', { detail: String(out.detail ?? code ?? 'unknown').slice(0, 300) });
	}
	const candidates: RepairCandidate[] = [];
	const seen = new Set<string>();
	for (const c of Array.isArray(out.candidates) ? out.candidates : []) {
		if (typeof c !== 'object' || c === null) continue;
		const rec = c as Record<string, unknown>;
		const latex = typeof rec.latex === 'string' ? rec.latex.trim() : '';
		// A `$$` inside would close the display block early when the candidate is applied.
		if (!latex || latex.includes('$$') || seen.has(latex)) continue;
		seen.add(latex);
		candidates.push({
			latex,
			source: typeof rec.source === 'string' ? rec.source : 'unknown',
			katexOk: typeof rec.katex_ok === 'boolean' ? rec.katex_ok : null
		});
	}
	const src = out.bbox_source;
	return {
		page: typeof out.page === 'number' ? out.page : 0,
		bbox: bboxOf(out.bbox),
		bboxSource: src === 'marker' || src === 'match' ? src : 'none',
		candidates
	};
}
