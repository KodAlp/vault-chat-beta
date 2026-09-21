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
 * A failure returns a Turkish message that is fed back to the model on the retry, like the other generators.
 */

export interface ValidatedQuizItem {
	type: QuizItemKind;
	question: string;
	options?: string[];
	answer: string;
	explanation: string;
	source_path: string;
	heading_path: string;
	/** The S-id the model cited — kept so the caller can see which source parts a quiz actually used. */
	sourceId: string;
}

export type BatchParse = { ok: true; items: ValidatedQuizItem[] } | { ok: false; error: string };

export interface BatchContext {
	idToChunk: ReadonlyMap<string, { path: string; heading_path: string }>;
	expectedCount: number;
	/** Set for a type-homogeneous batch; every item must be this type. */
	kind?: QuizItemKind;
	/** The source ids this batch was shown. Anything else is rejected. Defaults to every known id. */
	allowedIds?: readonly string[];
	/** The source id each question must cite, by position (the grammar pins it; this is the defensive check). */
	slots?: readonly string[];
}

/** A leading option label such as "A) ", "b." or "C:". */
const LETTER_LABEL = /^\s*[A-Ea-e][)\.:]\s*/;

/** A true/false item must be a statement to judge, not a question to answer. */
export function isStatement(question: string): boolean {
	return !/[?？]\s*$/u.test(question.trim());
}

/**
 * Whether `text` contains one of the prompt's source ids ("S7") as a word. Ids are only meaningful inside the prompt, so a student
 * must never see one. Only ids of THIS batch's pool count, which keeps "S" followed by digits elsewhere from being flagged
 * unless it collides with a real id (a bare "S3" for a symmetric group would; the batch is then regenerated, which is cheap).
 * Language-independent on purpose: it looks for the id itself, not for the Turkish phrases around it.
 */
export function leaksSourceId(text: string, ids: Iterable<string>): boolean {
	for (const id of ids) {
		if (new RegExp(String.raw`(?<![\p{L}\p{N}_])${id}(?![\p{L}\p{N}_])`, 'u').test(text)) return true;
	}
	return false;
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

export function validateQuizBatch(raw: string, ctx: BatchContext): BatchParse {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, error: 'Model geçerli JSON döndürmedi.' };
	}
	const parsed = QuizItems.safeParse(json);
	if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
	const items = parsed.data.items;

	if (items.length !== ctx.expectedCount) {
		return { ok: false, error: `Model ${ctx.expectedCount} soru istenirken ${items.length} soru üretti. Tam olarak ${ctx.expectedCount} soru üret.` };
	}
	const allowed = new Set(ctx.allowedIds ?? ctx.idToChunk.keys());
	const badIds = items.filter((i) => !allowed.has(i.source_id) || !ctx.idToChunk.has(i.source_id));
	if (badIds.length > 0) {
		return { ok: false, error: `${badIds.length} sorunun source_id'si sağlanan kaynak kimlikleriyle eşleşmiyor. Sadece ${[...allowed].join(', ')} kimliklerini kullan.` };
	}
	if (ctx.kind) {
		const wrong = items.filter((i) => i.type !== ctx.kind);
		if (wrong.length > 0) return { ok: false, error: `${wrong.length} sorunun türü yanlış. Bu partideki tüm sorular ${ctx.kind} türünde olmalı.` };
	}
	if (ctx.slots) {
		const off = items.findIndex((it, i) => it.source_id !== ctx.slots![i]);
		if (off !== -1) return { ok: false, error: `${off + 1}. sorunun source_id'si ${ctx.slots[off]} olmalı (her sorunun kaynağı sabit).` };
	}

	const out: ValidatedQuizItem[] = [];
	for (const item of items) {
		const chunk = ctx.idToChunk.get(item.source_id)!;
		const visible = [item.question, item.explanation, ...(item.options ?? [])];
		if (visible.some((t) => leaksSourceId(t, ctx.idToChunk.keys()))) {
			return { ok: false, error: 'Soru, seçenek ve açıklama metinlerinde S1, S2 gibi kaynak kimliklerini ya da "S7 kaynağına göre" gibi ifadeleri yazma; öğrenci bu kimlikleri görmez. Soruyu kimliğe atıf yapmadan, konunun kendisi hakkında yaz.' };
		}
		let answer = item.answer.trim();
		let options = item.options;

		if (item.type === 'multiple_choice') {
			if (!options || options.length !== 5) return { ok: false, error: 'Çoktan seçmeli her soruda tam olarak 5 seçenek (options) olmalı.' };
			if (new Set(options.map((o) => o.trim().toLowerCase())).size !== 5) return { ok: false, error: 'Çoktan seçmeli sorunun 5 seçeneği birbirinden farklı olmalı.' };
			const match = matchOption(answer, options);
			if (match === null) return { ok: false, error: 'Çoktan seçmeli sorunun answer alanı, options içindeki seçeneklerden biriyle birebir aynı metin olmalı.' };
			answer = match; // the exact option text: that is what the quiz page sends back
		} else if (item.type === 'true_false') {
			answer = answer.toLowerCase();
			if (answer !== 'true' && answer !== 'false') return { ok: false, error: 'Doğru/yanlış sorularda answer tam olarak "true" veya "false" olmalı.' };
			if (!isStatement(item.question)) return { ok: false, error: 'Doğru/yanlış sorusu bir ifade olmalı, soru cümlesi (?) olmamalı; "…doğrudur" diyebileceğin bir cümle yaz.' };
			options = undefined;
		} else {
			options = undefined;
		}

		out.push({
			type: item.type,
			question: item.question,
			options,
			answer,
			explanation: item.explanation,
			source_path: chunk.path,
			heading_path: chunk.heading_path,
			sourceId: item.source_id
		});
	}
	return { ok: true, items: out };
}
