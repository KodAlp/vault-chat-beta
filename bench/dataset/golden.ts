/**
 * Pure schema/quality helpers for the RAG benchmark's golden question set.
 * No DB, no `$lib`/`$env` imports — everything that needs the live index
 * (anchor resolution, domain lookup via files.domains_json, chunk text for
 * the leakage check) lives in validate-golden.ts and is passed in here as
 * plain data. This split is what lets golden.test.ts exercise the schema/
 * duplicate/overlap logic under plain `node:test` with no index.db at all,
 * same reasoning as bench/lib/{anchor,metrics,fusion}.ts.
 */

export type QuestionType =
	| 'direct'
	| 'conceptual'
	| 'multi_hop'
	| 'cross_document'
	| 'comparison'
	| 'numerical'
	| 'long_context'
	| 'ambiguous'
	| 'unanswerable'
	| 'followup'
	| 'smalltalk';

export const QUESTION_TYPES: readonly QuestionType[] = [
	'direct',
	'conceptual',
	'multi_hop',
	'cross_document',
	'comparison',
	'numerical',
	'long_context',
	'ambiguous',
	'unanswerable',
	'followup',
	'smalltalk'
];

/** Types where the spec requires relevant spans to cover >=2 distinct paths
 * (checked as a warning, not an error — a hand-written question can genuinely
 * need just one file's two sections). */
export const MULTI_SPAN_TYPES: readonly QuestionType[] = ['multi_hop', 'cross_document', 'comparison'];

export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];

export type Lang = 'tr' | 'en';
export const LANGS: readonly Lang[] = ['tr', 'en'];

export interface GoldenTurn {
	role: 'user' | 'assistant';
	content: string;
}

export interface GoldenRelevant {
	anchor: string;
	path: string;
	heading_path: string;
	grade: 1 | 2;
}

export interface GoldenLine {
	id: string;
	question: string;
	turns?: GoldenTurn[];
	type: QuestionType;
	difficulty: Difficulty;
	lang: Lang;
	answerable: boolean;
	relevant: GoldenRelevant[];
	reference_answer: string;
	notes?: string;
}

export interface ParseResult {
	line?: GoldenLine;
	errors: string[];
}

function isString(v: unknown): v is string {
	return typeof v === 'string';
}

function isBoolean(v: unknown): v is boolean {
	return typeof v === 'boolean';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validates one already-JSON-parsed golden object against the schema. Never
 * throws — every problem becomes a message in `errors`, so a caller can
 * report every issue on a line instead of stopping at the first one.
 */
export function validateGoldenObject(obj: unknown): ParseResult {
	const errors: string[] = [];
	if (!isPlainObject(obj)) {
		return { errors: ['golden satırı bir JSON nesnesi değil'] };
	}

	if (!isString(obj.id) || obj.id.length === 0) errors.push('`id` eksik veya boş string değil');
	if (!isString(obj.question) || obj.question.trim().length === 0) errors.push('`question` eksik veya boş string değil');
	if (!isString(obj.type) || !QUESTION_TYPES.includes(obj.type as QuestionType)) {
		errors.push(`\`type\` geçersiz: ${JSON.stringify(obj.type)} (beklenen: ${QUESTION_TYPES.join(', ')})`);
	}
	if (!isString(obj.difficulty) || !DIFFICULTIES.includes(obj.difficulty as Difficulty)) {
		errors.push(`\`difficulty\` geçersiz: ${JSON.stringify(obj.difficulty)} (beklenen: ${DIFFICULTIES.join(', ')})`);
	}
	if (!isString(obj.lang) || !LANGS.includes(obj.lang as Lang)) {
		errors.push(`\`lang\` geçersiz: ${JSON.stringify(obj.lang)} (beklenen: ${LANGS.join(', ')})`);
	}
	if (!isBoolean(obj.answerable)) errors.push('`answerable` eksik veya boolean değil');
	if (!isString(obj.reference_answer)) errors.push('`reference_answer` eksik veya string değil');

	let relevant: GoldenRelevant[] = [];
	if (!Array.isArray(obj.relevant)) {
		errors.push('`relevant` bir dizi değil');
	} else {
		obj.relevant.forEach((r, i) => {
			if (!isPlainObject(r)) {
				errors.push(`relevant[${i}] bir nesne değil`);
				return;
			}
			if (!isString(r.anchor) || r.anchor.length === 0) errors.push(`relevant[${i}].anchor eksik/boş`);
			if (!isString(r.path) || r.path.length === 0) errors.push(`relevant[${i}].path eksik/boş`);
			if (!isString(r.heading_path)) errors.push(`relevant[${i}].heading_path string değil`);
			if (r.grade !== 1 && r.grade !== 2) errors.push(`relevant[${i}].grade geçersiz: ${JSON.stringify(r.grade)} (1 veya 2 olmalı)`);
		});
		if (errors.length === 0 || obj.relevant.every((r) => isPlainObject(r))) {
			relevant = obj.relevant as GoldenRelevant[];
		}
	}

	if (obj.turns !== undefined) {
		if (!Array.isArray(obj.turns)) {
			errors.push('`turns` bir dizi değil');
		} else {
			obj.turns.forEach((t, i) => {
				if (!isPlainObject(t) || (t.role !== 'user' && t.role !== 'assistant') || !isString(t.content)) {
					errors.push(`turns[${i}] geçersiz (role: 'user'|'assistant', content: string olmalı)`);
				}
			});
		}
	}

	if (obj.notes !== undefined && !isString(obj.notes)) errors.push('`notes` string değil');

	if (errors.length > 0) return { errors };

	const line: GoldenLine = {
		id: obj.id as string,
		question: obj.question as string,
		type: obj.type as QuestionType,
		difficulty: obj.difficulty as Difficulty,
		lang: obj.lang as Lang,
		answerable: obj.answerable as boolean,
		relevant,
		reference_answer: obj.reference_answer as string,
		...(obj.turns !== undefined ? { turns: obj.turns as GoldenTurn[] } : {}),
		...(obj.notes !== undefined ? { notes: obj.notes as string } : {})
	};
	return { line, errors: [] };
}

/** JSON.parse + schema validation for one JSONL line. `lineNo` is 1-indexed,
 * folded into every error message so a validator report can point straight
 * at the offending line without the caller re-deriving it. */
export function parseGoldenLine(raw: string, lineNo: number): ParseResult {
	let obj: unknown;
	try {
		obj = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { errors: [`satır ${lineNo}: JSON parse hatası — ${message}`] };
	}
	const result = validateGoldenObject(obj);
	if (result.errors.length > 0) {
		return { errors: result.errors.map((e) => `satır ${lineNo}: ${e}`) };
	}
	return result;
}

/**
 * answerable ⇒ >=1 relevant; unanswerable/smalltalk ⇒ relevant empty AND
 * answerable=false. Returns error strings (not warnings) per the spec.
 */
export function checkAnswerabilityRules(line: GoldenLine): string[] {
	const errors: string[] = [];
	if (line.answerable && line.relevant.length === 0) {
		errors.push(`id=${line.id}: answerable=true ama relevant boş`);
	}
	if (line.type === 'unanswerable' || line.type === 'smalltalk') {
		if (line.relevant.length > 0) errors.push(`id=${line.id}: type=${line.type} ama relevant boş değil`);
		if (line.answerable !== false) errors.push(`id=${line.id}: type=${line.type} ama answerable=false değil`);
	}
	return errors;
}

/** multi_hop/cross_document/comparison should span >=2 distinct paths — a
 * warning (not an error): a hand-written question can legitimately need
 * only one file's two sections. */
export function checkMultiSpanRule(line: GoldenLine): string[] {
	if (!MULTI_SPAN_TYPES.includes(line.type)) return [];
	const distinctPaths = new Set(line.relevant.map((r) => r.path));
	if (distinctPaths.size < 2) {
		return [`id=${line.id}: type=${line.type} ama relevant sadece ${distinctPaths.size} farklı dosyaya işaret ediyor (>=2 beklenir)`];
	}
	return [];
}

/** Collapses case, punctuation and whitespace for exact-duplicate detection.
 * Deliberately locale-aware lowercasing (Turkish İ/I) via toLocaleLowerCase. */
export function normalizeQuestionText(q: string): string {
	return q
		.toLocaleLowerCase('tr')
		.replace(/[^\p{L}\p{N}\s]/gu, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Unicode-aware lowercase word/number tokens, used for both near-duplicate
 * Jaccard and the question/chunk overlap (leakage) check. */
export function tokenize(text: string): string[] {
	return text.toLocaleLowerCase('tr').match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let intersection = 0;
	for (const x of a) if (b.has(x)) intersection++;
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

export interface DuplicatePair {
	a: string;
	b: string;
	jaccard: number;
	exact: boolean;
}

/**
 * O(n^2) pairwise comparison — fine at benchmark scale (a few hundred
 * questions). Exact duplicates (normalized text equality) are always
 * reported; near-duplicates (token Jaccard >= threshold) are reported
 * separately unless already caught as exact.
 */
export function findDuplicateQuestions(lines: GoldenLine[], jaccardThreshold = 0.8): DuplicatePair[] {
	const normalized = lines.map((l) => normalizeQuestionText(l.question));
	const tokenSets = lines.map((l) => new Set(tokenize(l.question)));
	const pairs: DuplicatePair[] = [];
	for (let i = 0; i < lines.length; i++) {
		for (let j = i + 1; j < lines.length; j++) {
			const exact = normalized[i].length > 0 && normalized[i] === normalized[j];
			const j_ = jaccard(tokenSets[i], tokenSets[j]);
			if (exact || j_ >= jaccardThreshold) {
				pairs.push({ a: lines[i].id, b: lines[j].id, jaccard: j_, exact });
			}
		}
	}
	return pairs;
}

/**
 * Share of the QUESTION's unique tokens that also appear in the chunk text —
 * a high value means the question all but copies the note verbatim, which
 * inflates BM25/keyword-fallback scores and makes the benchmark easier than
 * a real user question would be. 0 when the question has no tokens at all
 * (never expected in practice, but keeps this total rather than throwing).
 */
export function questionChunkOverlap(questionTokens: string[], chunkTokens: Set<string>): number {
	const unique = new Set(questionTokens);
	if (unique.size === 0) return 0;
	let hit = 0;
	for (const t of unique) if (chunkTokens.has(t)) hit++;
	return hit / unique.size;
}

export interface Distribution {
	byType: Record<string, number>;
	byLang: Record<string, number>;
	byDifficulty: Record<string, number>;
	total: number;
}

function bump(rec: Record<string, number>, key: string): void {
	rec[key] = (rec[key] ?? 0) + 1;
}

export function computeDistribution(lines: GoldenLine[]): Distribution {
	const byType: Record<string, number> = {};
	const byLang: Record<string, number> = {};
	const byDifficulty: Record<string, number> = {};
	for (const l of lines) {
		bump(byType, l.type);
		bump(byLang, l.lang);
		bump(byDifficulty, l.difficulty);
	}
	return { byType, byLang, byDifficulty, total: lines.length };
}

/** Domain distribution needs a path -> domains lookup from the live index
 * (files.domains_json), so it's passed in rather than queried here — keeps
 * this module DB-free. Counts a domain once per question (union over all of
 * its relevant paths), not once per relevant chunk, so a question with 3
 * chunks in the same domain doesn't outweigh one with 3 chunks in 3 domains. */
export function computeDomainDistribution(lines: GoldenLine[], pathToDomains: Map<string, string[]>): Record<string, number> {
	const byDomain: Record<string, number> = {};
	for (const l of lines) {
		const domains = new Set<string>();
		for (const r of l.relevant) {
			for (const d of pathToDomains.get(r.path) ?? []) domains.add(d);
		}
		for (const d of domains) bump(byDomain, d);
	}
	return byDomain;
}

export interface TargetProfile {
	name: string;
	byType: Partial<Record<QuestionType, number>>;
	/** Sum of the "core" question types (everything except followup/smalltalk)
	 * — pilot only specifies this as one number ("60 questions"), not a
	 * per-type breakdown. */
	core?: number;
	langTrShare: number;
}

export const PILOT_TARGET: TargetProfile = {
	name: 'pilot',
	byType: { followup: 6, smalltalk: 4 },
	core: 60,
	langTrShare: 0.7
};

export const FULL_TARGET: TargetProfile = {
	name: 'full',
	byType: {
		direct: 50,
		conceptual: 50,
		multi_hop: 50,
		cross_document: 40,
		comparison: 30,
		numerical: 30,
		long_context: 20,
		ambiguous: 15,
		unanswerable: 15,
		followup: 20,
		smalltalk: 10
	},
	langTrShare: 0.7
};

/** Deviation warnings comparing an actual distribution against a target
 * profile — printed, never thrown; a benchmark's golden set is allowed to
 * fall short of target while work continues. `langTolerance` is a fraction
 * of the total (default 10 percentage points) before a lang-mix deviation
 * is reported. */
export function compareToTargets(dist: Distribution, target: TargetProfile, langTolerance = 0.1): string[] {
	const warnings: string[] = [];
	for (const [type, want] of Object.entries(target.byType)) {
		const have = dist.byType[type] ?? 0;
		if (have !== want) warnings.push(`[${target.name}] tip '${type}': ${have} adet, hedef ${want}`);
	}
	if (target.core !== undefined) {
		const coreTypes = QUESTION_TYPES.filter((t) => !(t in target.byType));
		const haveCore = coreTypes.reduce((sum, t) => sum + (dist.byType[t] ?? 0), 0);
		if (haveCore !== target.core) {
			warnings.push(`[${target.name}] çekirdek sorular (followup/smalltalk hariç): ${haveCore} adet, hedef ${target.core}`);
		}
	}
	if (dist.total > 0) {
		const trShare = (dist.byLang.tr ?? 0) / dist.total;
		const deviation = Math.abs(trShare - target.langTrShare);
		if (deviation > langTolerance) {
			warnings.push(
				`[${target.name}] dil dağılımı: %${(trShare * 100).toFixed(1)} tr, hedef ~%${(target.langTrShare * 100).toFixed(0)} (sapma %${(deviation * 100).toFixed(1)})`
			);
		}
	}
	return warnings;
}
