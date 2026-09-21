import { QuizItems, type QuizItemKind } from './quiz-schema';

/**
 * Validates one generated batch. Pure and free of $env/providers, like cards-validate.ts, so it runs under plain
 * `tsx --test` (generate-quiz.ts cannot). Everything here exists because the previous check counted the items and
 * nothing else, and the real vault paid for it:
 *  - 46 of 80 multiple-choice questions had NO options and 2 more had the wrong number — unanswerable;
 *  - a true/false answer stored as "False" is never equal to the "false" the page sends, so it is graded wrong forever;
 *  - a "true/false" question that reads "…kaçtır?" is not a statement;
 *  - the same question came back verbatim from a later batch (source-part spread is enforced separately);
 *  - the prompt's own source ids leaked into the text the student reads ("S7 kaynak parçasında verilen … kullanarak"): 8 of 156
 *    questions from the first slot-based generator, none in the 129 stored ones (the old prompt never said "question 1 comes from S7").
 * A failure returns a Turkish message that is fed back to the model on the retry, like the other generators, and a `code` the
 * caller can log and count without parsing that text.
 */

export interface ValidatedQuizItem {
	type: QuizItemKind;
	question: string;
	options?: string[];
	answer: string;
	explanation: string;
	source_path: string;
	heading_path: string;
	/** The level the question targets; only present when levels were asked for. */
	cognitiveLevel?: string;
	/** The S-id the model cited — kept so the caller can see which source parts a quiz actually used. */
	sourceId: string;
}

export type BatchFailureCode =
	| 'json'
	| 'schema'
	| 'count'
	| 'source_id'
	| 'type'
	| 'slot'
	| 'options_count'
	| 'options_not_distinct'
	| 'answer_not_option'
	| 'answer_not_bool'
	| 'not_statement'
	| 'id_in_question'
	| 'level';

export type BatchParse = { ok: true; items: ValidatedQuizItem[] } | { ok: false; error: string; code: BatchFailureCode };

export interface BatchChunk {
	path: string;
	heading_path: string;
	/** The part's own text. When present, an "S3" that appears in it is content ("Schedule S3"), not a leaked id. */
	display_text?: string;
}

export interface BatchContext {
	idToChunk: ReadonlyMap<string, BatchChunk>;
	expectedCount: number;
	/** Set for a type-homogeneous batch; every item must be this type. */
	kind?: QuizItemKind;
	/** The source ids this batch was shown. Anything else is rejected. Defaults to every known id. */
	allowedIds?: readonly string[];
	/** The source id each question must cite, by position (the grammar pins it; this is the defensive check). */
	slots?: readonly string[];
	/** The target level of each question, by position (pinned by the grammar; this is the defensive check). Absent = no levels. */
	levels?: readonly string[];
}

/** A leading option label such as "A) ", "b." or "C:". */
const LETTER_LABEL = /^\s*[A-Ea-e][)\.:]\s*/;

/** A true/false item must be a statement to judge, not a question to answer. */
export function isStatement(question: string): boolean {
	return !/[?？]\s*$/u.test(question.trim());
}

const idPattern = (id: string) => new RegExp(String.raw`(?<![\p{L}\p{N}_])${id}(?![\p{L}\p{N}_])`, 'u');

/**
 * Whether `text` contains one of the prompt's source ids ("S7") as a word. Ids are only meaningful inside the prompt, so a student
 * must never see one. An id that also appears in `exempt` (the source parts the batch was shown) is that part's own content — a
 * database note's "Schedule S1" — and does not count. Language-independent on purpose: it looks for the id itself, not for the
 * Turkish phrases around it.
 */
export function leaksSourceId(text: string, ids: Iterable<string>, exempt: readonly string[] = []): boolean {
	for (const id of ids) {
		const re = idPattern(id);
		if (re.test(text) && !exempt.some((e) => re.test(e))) return true;
	}
	return false;
}

/**
 * The human name of a source part: the root of its heading path (a note's title), which is what a student would call it.
 * Falls back to the file name without extension.
 */
export function sourceLabel(chunk: { path: string; heading_path: string }): string {
	const root = chunk.heading_path.split('>')[0].trim();
	if (root) return root;
	return (chunk.path.split('/').pop() ?? chunk.path).replace(/\.[^.]+$/, '');
}

/**
 * Replaces each leaked source id in `text` with the name of the part it stands for ("S1 kaynakça, …" → "Database System Concepts
 * kaynakça, …"). Used for the EXPLANATION only: measured on 42 generated batches, every leak that got a batch rejected sat in the
 * explanation (53 places) and none in a question or an option, and rejecting them cost 9-11 of the 18 retries per 12 quizzes
 * and lost 2-4 batches — the model does it again on the retry, because the parts it was shown are bibliography-like notes.
 * An id that is the part's own content is left alone.
 */
export function replaceSourceIds(text: string, ctx: { idToChunk: ReadonlyMap<string, BatchChunk> }, exempt: readonly string[] = []): string {
	let out = text;
	for (const [id, chunk] of ctx.idToChunk) {
		const re = idPattern(id);
		if (re.test(out) && !exempt.some((e) => re.test(e))) out = out.replace(new RegExp(re.source, 'gu'), () => sourceLabel(chunk));
	}
	return out;
}

/** The option `answer` refers to: exact match first, then ignoring a stray "A) " label on either side; null if none. */
export function matchOption(answer: string, options: readonly string[]): string | null {
	const a = answer.trim();
	const exact = options.find((o) => o.trim() === a);
	if (exact !== undefined) return exact;
	const strip = (s: string) => s.replace(LETTER_LABEL, '').trim();
	const loose = options.filter((o) => strip(o) === strip(a));
	return loose.length === 1 ? loose[0] : null;
}

const fail = (code: BatchFailureCode, error: string): BatchParse => ({ ok: false, error, code });

export function validateQuizBatch(raw: string, ctx: BatchContext): BatchParse {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return fail('json', 'Model geçerli JSON döndürmedi.');
	}
	const parsed = QuizItems.safeParse(json);
	if (!parsed.success) return fail('schema', parsed.error.issues.map((i) => i.message).join('; '));
	const items = parsed.data.items;

	if (items.length !== ctx.expectedCount) {
		return fail('count', `Model ${ctx.expectedCount} soru istenirken ${items.length} soru üretti. Tam olarak ${ctx.expectedCount} soru üret.`);
	}
	const allowed = new Set(ctx.allowedIds ?? ctx.idToChunk.keys());
	const badIds = items.filter((i) => !allowed.has(i.source_id) || !ctx.idToChunk.has(i.source_id));
	if (badIds.length > 0) {
		return fail('source_id', `${badIds.length} sorunun source_id'si sağlanan kaynak kimlikleriyle eşleşmiyor. Sadece ${[...allowed].join(', ')} kimliklerini kullan.`);
	}
	if (ctx.kind) {
		const wrong = items.filter((i) => i.type !== ctx.kind);
		if (wrong.length > 0) return fail('type', `${wrong.length} sorunun türü yanlış. Bu partideki tüm sorular ${ctx.kind} türünde olmalı.`);
	}
	if (ctx.slots) {
		const off = items.findIndex((it, i) => it.source_id !== ctx.slots![i]);
		if (off !== -1) return fail('slot', `${off + 1}. sorunun source_id'si ${ctx.slots[off]} olmalı (her sorunun kaynağı sabit).`);
	}
	if (ctx.levels) {
		const off = items.findIndex((it, i) => it.cognitive_level !== ctx.levels![i]);
		if (off !== -1) return fail('level', `${off + 1}. sorunun cognitive_level değeri ${ctx.levels[off]} olmalı.`);
	}

	// The parts this batch was shown: an id-looking token that occurs in them is their own content.
	const shown = [...allowed].map((id) => ctx.idToChunk.get(id)?.display_text).filter((t): t is string => typeof t === 'string');

	const out: ValidatedQuizItem[] = [];
	for (const item of items) {
		const chunk = ctx.idToChunk.get(item.source_id)!;
		let answer = item.answer.trim();
		let options = item.options;

		// An id in the question or an option is not repaired: the student would be asked about "S3", which says nothing to them.
		if ([item.question, ...(item.options ?? [])].some((t) => leaksSourceId(t, ctx.idToChunk.keys(), shown))) {
			return fail('id_in_question', 'Soru ve seçenek metinlerinde S1, S2 gibi kaynak kimlikleri bulunmamalı; öğrenci bu kimlikleri görmez. Soruyu kimliğe atıf yapmadan, konunun kendisi hakkında yaz.');
		}
		const explanation = replaceSourceIds(item.explanation, ctx, shown);

		if (item.type === 'multiple_choice') {
			if (!options || options.length !== 5) return fail('options_count', 'Çoktan seçmeli her soruda tam olarak 5 seçenek (options) olmalı.');
			if (new Set(options.map((o) => o.trim().toLowerCase())).size !== 5) return fail('options_not_distinct', 'Çoktan seçmeli sorunun 5 seçeneği birbirinden farklı olmalı.');
			const match = matchOption(answer, options);
			if (match === null) return fail('answer_not_option', 'Çoktan seçmeli sorunun answer alanı, options içindeki seçeneklerden biriyle birebir aynı metin olmalı.');
			answer = match; // the exact option text: that is what the quiz page sends back
		} else if (item.type === 'true_false') {
			answer = answer.toLowerCase();
			if (answer !== 'true' && answer !== 'false') return fail('answer_not_bool', 'Doğru/yanlış sorularda answer tam olarak "true" veya "false" olmalı.');
			if (!isStatement(item.question)) return fail('not_statement', 'Doğru/yanlış sorusu bir ifade olmalı, soru cümlesi (?) olmamalı; "…doğrudur" diyebileceğin bir cümle yaz.');
			options = undefined;
		} else {
			options = undefined;
		}

		out.push({
			type: item.type,
			question: item.question,
			options,
			answer,
			explanation,
			source_path: chunk.path,
			heading_path: chunk.heading_path,
			...(ctx.levels ? { cognitiveLevel: item.cognitive_level } : {}),
			sourceId: item.source_id
		});
	}
	return { ok: true, items: out };
}
