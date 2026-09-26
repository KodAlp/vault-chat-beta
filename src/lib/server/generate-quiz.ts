import { chatWithFallback } from './providers/registry';
import type { ChatMessage } from './providers/types';
import { retrieve } from './retrieve';
import { getMessages } from './chats-db';
import { buildQuizItemsJsonSchema } from './quiz-schema';
import { createQuiz, type NewQuizItem } from './study-db';
import { splitCompositionByType, assignSlots, type QuizItemType } from './quiz-batch';
import { selectTeachingPool } from './quiz-pool';
import { dedupeItems } from './quiz-dedupe';
import { validateQuizBatch, type BatchFailureCode } from './quiz-validate';
import { shuffleQuestionOptions } from './quiz-options';
import { assignLevels } from '../cognitive-levels';
import { buildBatchUserPrompt } from './quiz-prompt';
import { chunkSupportsApplication } from './chunk-signals';
import { logAppEvent } from './app-log';
import { renderUserSkillsBlock } from './userSkills';
import type { VaultContext } from './vaults';
import { NoSourcesError } from './generate-errors';
import { AppError } from './app-error';

export interface GenerateQuizInput {
	domains?: string[];
	chatId?: string;
	prompt: string;
	composition: { mc: number; tf: number; open: number };
	/** Skill spec: generation defaults to the user's reasoning model. */
	model: string;
	/** See ChatRequestBody.provider's doc comment ($lib/types.ts) — same
	 * optional pin, threaded into every chatWithFallback call below. */
	provider?: string;
	/** Chat's own source-tree scope selection — see ChatRequestBody.includedPaths. */
	includedPaths?: string[];
	/**
	 * Off unless the user turned on Settings.quizLevelLabels. When set, every question is assigned a cognitive level (from a menu
	 * that fits its type and its source part), the grammar pins it and it is stored. When not set the prompts, the grammar and the
	 * stored rows are exactly what they were before levels existed.
	 */
	levels?: boolean;
}

export type ProgressStage = 'retrieving' | 'generating' | 'validating' | 'retrying';

/** The client's own <input max="20"> only stops the spinner arrows, not
 * typed values, and the server must never trust client-side validation
 * alone — an unclamped count reaches the prompt as "Tam olarak 600 soruluk
 * bir test hazırla", which is guaranteed to run long or time out with no
 * explanation to the user. */
function clampComposition(composition: GenerateQuizInput['composition']) {
	const clamp = (n: number) => Math.max(0, Math.min(20, Math.round(n) || 0));
	return { mc: clamp(composition.mc), tf: clamp(composition.tf), open: clamp(composition.open) };
}

/**
 * Batching (fixes the local-model quality-collapse bug): a single call used
 * to ask for up to 60 questions via a grammar that FORBIDS returning fewer
 * (quiz-schema.ts's minItems === maxItems), so the model had to keep
 * producing structured JSON with no room to stop even as quality degraded
 * near the end of its context window. Splitting into small batches means no
 * single decode is ever asked for more than QUIZ_ITEMS_PER_BATCH questions
 * — see generate-cards.ts's CARDS_PER_BATCH for the identical reasoning
 * applied there.
 */
const QUIZ_ITEMS_PER_BATCH = 5;

/**
 * Candidates asked of retrieval and the pool kept from them. Index pages and "Related"/"Sources" sections rank high
 * (they name the topic) but teach nothing, so more than a pool's worth is retrieved and only teaching parts are kept
 * (quiz-pool.ts). Measured: 17% of the vault's chunks are such parts, they were 20-30% of the pools handed to the
 * generator, and two of four test quizzes drew questions from a "> Related" / "> Sources" section.
 */
const QUIZ_CANDIDATES = 24;
const QUIZ_POOL_SIZE = 12;

/**
 * See generate-cards.ts's cardsOutputBudget for the same reasoning — a
 * generous runaway guard, not a tuned allowance. ~450 tokens/item (higher
 * than cards' estimate: a multiple-choice item carries 5 options plus an
 * explanation on top of question/answer/source_id) is an ENGINEERING
 * ESTIMATE, not a measured number.
 */
function quizOutputBudget(batchSize: number): number {
	return 400 + batchSize * 450;
}

const QUERY_EXTRACT_SYSTEM_PROMPT =
	'Kullanıcının test/sınav isteğinden, sadece KONUYU özetleyen kısa bir arama sorgusu çıkar. "test hazırla", "soru üret" gibi talimat kelimelerini ATLA, sadece konuyu yaz. Tek satır, sadece sorgu metni, başka hiçbir şey yazma.';

/**
 * retrieve() embeds the query text directly — an instructional sentence like
 * "... üzerine kısa bir test hazırla" measurably degrades the embedding match
 * versus a clean topical phrase (verified empirically: the exact same prompt
 * through the existing /api/chat domain filter also returned nothing useful).
 * Strip the instruction framing via a quick model call before retrieving.
 *
 * temperature:0 is load-bearing here, not cosmetic: without it this call uses
 * the model's default (non-zero) sampling, so the *same* user prompt can
 * extract a *different* query text on each call — and therefore sometimes
 * find nothing and sometimes find good matches, purely by sampling luck. That
 * inconsistency is what got reported as a suspected race condition; it
 * wasn't concurrency, it was this call being non-deterministic.
 */
const QUERY_EXTRACT_BUDGET_MS = 60_000;

async function extractTopicalQuery(prompt: string, model: string, provider?: string): Promise<string> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: QUERY_EXTRACT_SYSTEM_PROMPT },
		{ role: 'user', content: prompt }
	];
	let text = '';
	// Bounded like the main call: this only has to produce a one-line search
	// query, so anything longer than a minute means it is not going to.
	const signal = AbortSignal.timeout(QUERY_EXTRACT_BUDGET_MS);
	for await (const event of chatWithFallback(
		'quiz',
		{ model, messages, think: false, temperature: 0 },
		signal,
		provider
	)) {
		if (event.type === 'text') text += event.text;
	}
	return text.trim() || prompt;
}

const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Hard ceiling on ONE generation, shared across the first attempt and every
 * retry — not a per-call limit, so the retries cannot multiply it. Same
 * value and reasoning as generate-mindmap.ts's GENERATION_BUDGET_MS: every
 * generator used to build `new AbortController().signal` and never abort
 * it, and a real run was observed spending 28 minutes inside a single call
 * and holding Ollama hostage the whole time — no other generation, and no
 * chat, could run. 12 minutes is deliberately generous (healthy runs on
 * this hardware land between 90s and ~10 minutes); the point is that the
 * run ends, not that it ends quickly.
 */
const GENERATION_BUDGET_MS = 12 * 60_000;

/** Ollama's own firstTokenMs budget covers a cold model load + a large
 * JSON-schema-constrained decode (up to 300s, see providers.json) — long
 * enough that a silent "generating" spinner reads as hung even when the
 * request is healthy. `onTick` fires on a fixed wall-clock interval
 * (independent of whether any bytes have actually arrived yet) so the
 * caller can surface a live "still working" signal — mirrors
 * generate-mindmap.ts's callModel() exactly. */
async function callModel(
	model: string,
	systemPrompt: string,
	userPrompt: string,
	format: object,
	provider: string | undefined,
	signal: AbortSignal,
	onTick?: (elapsedMs: number) => void,
	maxOutputTokens?: number
): Promise<string> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt }
	];
	let text = '';
	const startedAt = Date.now();
	const timer = onTick ? setInterval(() => onTick(Date.now() - startedAt), HEARTBEAT_INTERVAL_MS) : undefined;
	try {
		for await (const event of chatWithFallback(
			'quiz',
			{ model, messages, think: false, format, temperature: 0.3, maxOutputTokens },
			signal,
			provider
		)) {
			if (event.type === 'text') text += event.text;
		}
	} finally {
		if (timer) clearInterval(timer);
	}
	return text;
}

/** Exported for /api/skills/preview — lets the settings page show exactly
 * how a scope's system prompt is assembled without a real generation call. */
export function buildSystemPrompt(
	composition: GenerateQuizInput['composition'],
	contextBlock: string,
	userSkillsBlock: string
): string {
	const total = composition.mc + composition.tf + composition.open;
	const taskIntro = `Sen bir sınav hazırlama asistanısın. Aşağıdaki <context> bloğu, her biri kısa bir kimlikle
(id: S1, S2, ...) ve source_path/heading_path/depth etiketleriyle işaretlenmiş kaynak parçalarından oluşuyor. Tam olarak
${total} soruluk bir test hazırla: ${composition.mc} çoktan seçmeli (5 seçenek), ${composition.tf} doğru/yanlış, ${composition.open} açık uçlu.
Notların seviyesine (depth) uygun zorlukta sorular sor. Açık uçlu sorular SOMUT, kontrol edilebilir bir sonuç
gerektirmeli — öğrenciyi gerçekten hesaplama/türetme/kanıtlama yapmaya zorla. "X nasıl hesaplanır?", "Y'yi açıkla"
gibi yöntem anlatımı isteyen sorulardan KAÇIN; bunun yerine somut bir girdi ver ve öğrenciden onu çözmesini/
hesaplamasını iste. Matematik/hesaplama içeren kaynaklarda örnek: "$f(x) = x^2 + 3x$ fonksiyonunun $x=2$
noktasındaki türevini hesapla" YAZ, "türev nasıl hesaplanır?" YAZMA — cevap somut bir sayı/ifade olmalı (answer
alanına o sonucu yaz), açıklama değil.`;

	// Non-overridable, appended after any user skills — see userSkills.ts and
	// the user-skills skill doc's "assembly order" section.
	const invariants = `Kurallar:
- SADECE <context> bloğundaki bilgiye dayanarak sorular hazırla. Context dışında hiçbir bilgi
  kullanma — context'te olmayan bir konuda soru sorma, kendi bilgin olsa bile.
- Türkçe yaz. Matematik sadece $...$ (satır içi) veya $$...$$ (blok) içinde, asla çıplak LaTeX.
- Her sorunun source_id alanı, o soruyu hangi kaynak parçasından ürettiysen o parçanın id'si olmalı
  — sadece S1, S2, ... gibi verilen kimlikleri kullan, asla dosya yolu yazma.
- Çoktan seçmeli sorularda options tam olarak 5 seçenek içermeli, answer bu 5 seçenekten biriyle birebir aynı metin olmalı.
- Doğru/yanlış sorularda answer tam olarak "true" veya "false" olmalı.
- explanation alanı doğru cevabın nedenini 1-3 cümlede açıklamalı.`;

	return [taskIntro, userSkillsBlock, invariants, `<context>\n${contextBlock}\n</context>`]
		.filter(Boolean)
		.join('\n\n');
}

/**
 * Foreground pipeline — the skill explicitly forbids hidden background model
 * calls here ("the user owns their RAM"), so onProgress is meant to drive a
 * visible progress UI, not a fire-and-forget like title generation.
 */
export async function generateQuiz(
	v: VaultContext,
	input: GenerateQuizInput,
	onProgress?: (stage: ProgressStage, elapsedMs?: number) => void
): Promise<{ quizId: string; requested: number; delivered: number }> {
	onProgress?.('retrieving');
	input = { ...input, composition: clampComposition(input.composition) };
	const total = input.composition.mc + input.composition.tf + input.composition.open;
	if (total === 0) {
		throw new AppError('GEN_QUIZ_NO_TYPES');
	}

	const topicalQuery = await extractTopicalQuery(input.prompt, input.model, input.provider);
	let query = topicalQuery;
	if (input.chatId) {
		const recent = getMessages(input.chatId).slice(-6);
		if (recent.length > 0) {
			const summary = recent
				.map((m) => `${m.role}: ${m.content}`)
				.join('\n')
				.slice(0, 1500);
			query = `${topicalQuery}\n\n${summary}`;
		}
	}

	const retrieved = await retrieve(v, query, {
		domains: input.domains,
		includedPaths: input.includedPaths,
		k: QUIZ_CANDIDATES
	});
	if (retrieved.chunks.length === 0) {
		throw new NoSourcesError(retrieved.narrowScope, retrieved.reason);
	}
	const chunks = selectTeachingPool(retrieved.chunks, QUIZ_POOL_SIZE);

	// Short id per chunk (S1, S2, ...) instead of a path for the model to copy — see quiz-schema.ts.
	const idToChunk = new Map(chunks.map((c, i) => [`S${i + 1}`, c]));
	const poolIds = [...idToChunk.keys()];
	const supportsById = new Map(chunks.map((c, i) => [`S${i + 1}`, chunkSupportsApplication(c.display_text)]));
	const contextFor = (ids: readonly string[]) =>
		[...new Set(ids)]
			.map((id) => {
				const c = idToChunk.get(id)!;
				return `id: ${id}\nsource_path: ${c.path}\nheading_path: ${c.heading_path}\ndepth: ${c.depth}\n\n${c.display_text}`;
			})
			.join('\n\n---\n\n');
	const userSkillsBlock = await renderUserSkillsBlock('quiz');

	// One deadline for the whole generation, every batch and every retry included — unchanged from before batching.
	const deadline = AbortSignal.timeout(GENERATION_BUDGET_MS);

	type GenItem = NewQuizItem & { sourceId?: string };
	const compositionOf = (kind: QuizItemType, count: number) => ({
		mc: kind === 'multiple_choice' ? count : 0,
		tf: kind === 'true_false' ? count : 0,
		open: kind === 'open' ? count : 0
	});

	/**
	 * One batch: ONE question type, and each question tied to its own source part (`slots`, in order). Both are enforced
	 * by the grammar (quiz-schema.ts), not requested and hoped for:
	 *  - a batch used to mix types under one grammar, so the requested 4/2/4 came back 6/2/2 in every measured quiz and
	 *    46 of 80 real multiple-choice questions had no options (the list was optional);
	 *  - asking the model to spread across the sources and rejecting batches that did not only produced retry loops — it does
	 *    not spread (10 questions from 2-3 of 5-12 available parts) — while pinning the id per position guarantees it;
	 *  - the earlier questions are NOT pasted into the prompt any more: the small model copied them back (14 of 20
	 *    second-batch questions were exact copies), and batches with different source parts cannot re-ask each other's fact.
	 */
	const runBatch = async (kind: QuizItemType, slots: readonly string[]): Promise<GenItem[]> => {
		const count = slots.length;
		const ids = [...new Set(slots)];
		const levels = input.levels ? assignLevels(kind, count, slots.map((id) => supportsById.get(id) === true)) : undefined;
		const system = buildSystemPrompt(compositionOf(kind, count), contextFor(ids), userSkillsBlock);
		const format = buildQuizItemsJsonSchema(ids, count, kind, slots, levels);
		const prompt = buildBatchUserPrompt(input.prompt, kind, slots, levels);
		const budget = quizOutputBudget(count);
		const parse = (raw: string) => validateQuizBatch(raw, { idToChunk, expectedCount: count, kind, allowedIds: ids, slots, levels });

		onProgress?.('generating');
		let raw = await callModel(input.model, system, prompt, format, input.provider, deadline, (ms) => onProgress?.('generating', ms), budget);
		let parsed = parse(raw);
		const failures: BatchFailureCode[] = [];
		if (!parsed.ok) failures.push(parsed.code);
		const MAX_RETRIES = 2;
		for (let attempt = 0; !parsed.ok && attempt < MAX_RETRIES; attempt++) {
			onProgress?.('retrying');
			const retryPrompt = `${prompt}\n\nÖnceki cevabın geçersizdi: ${parsed.error}\nSADECE geçerli JSON döndür.`;
			raw = await callModel(input.model, system, retryPrompt, format, input.provider, deadline, (ms) => onProgress?.('retrying', ms), budget);
			parsed = parse(raw);
			if (!parsed.ok) failures.push(parsed.code);
		}
		// Retries and lost batches used to leave no trace at all; measured, half of all retries were one avoidable rule and a lost
		// batch is 4 questions the user never sees. Codes only (no text), like every other record in this log.
		if (failures.length > 0) {
			logAppEvent({ kind: 'generation_warning', generationType: 'quiz', model: input.model, reason: parsed.ok ? 'batch_retried' : 'batch_lost', message: `${kind} x${count}: ${failures.join(', ')}`, attempt: failures.length });
		}
		// Same partial-accept policy as generate-cards.ts: a batch that never validates even after retries is skipped, not a
		// reason to discard every question generated so far. Zero questions across every batch, below, is still a hard failure.
		// A thrown exception from callModel itself (network/timeout/abort) is NOT caught here — it propagates immediately.
		if (!parsed.ok) return [];
		// The model does not spread the correct option over the five slots (chi-square 22.2 over 88 questions); order is by text, so
		// shuffling here costs nothing (quiz-options.ts).
		return (parsed.items as GenItem[]).map((it) => {
			if (it.type !== 'multiple_choice' || !it.options) return it;
			const shuffled = shuffleQuestionOptions(it.options, it.answer);
			return { ...it, options: shuffled.options, answer: shuffled.answer };
		});
	};

	const batches = splitCompositionByType(input.composition, QUIZ_ITEMS_PER_BATCH);
	// One source part per question, dealt across the whole quiz: it uses as much of the pool as it has questions.
	const slotPlan = assignSlots(poolIds, batches.map((b) => b.count));

	let items: GenItem[] = [];
	onProgress?.('generating');
	for (let n = 0; n < batches.length; n++) items.push(...(await runBatch(batches[n].type, slotPlan[n])));

	// Safety net, not the fix: a verbatim repeat is dropped (quiz-dedupe.ts is deliberately exact — a fuzzy gate cannot tell a
	// paraphrase from "same template, different numbers"), then ONE top-up per type that came back short, drawn from source parts
	// nothing has used yet. Never padded with repeats: a short quiz is reported as short (requested/delivered).
	items = dedupeItems(items).kept;
	const want: Record<QuizItemType, number> = { multiple_choice: input.composition.mc, true_false: input.composition.tf, open: input.composition.open };
	for (const kind of ['multiple_choice', 'true_false', 'open'] as const) {
		const have = items.filter((i) => i.type === kind).length;
		if (have >= want[kind]) continue;
		const used = new Set(items.map((i) => i.sourceId));
		const fresh = poolIds.filter((id) => !used.has(id));
		const need = Math.min(QUIZ_ITEMS_PER_BATCH, want[kind] - have);
		const extra = await runBatch(kind, assignSlots(fresh.length > 0 ? fresh : poolIds, [need])[0]);
		items.push(...dedupeItems(extra, items.map((i) => i.question)).kept);
	}
	const order: Record<string, number> = { multiple_choice: 0, true_false: 1, open: 2 };
	items = items.map((it, idx) => ({ it, idx })).sort((x, y) => order[x.it.type] - order[y.it.type] || x.idx - y.idx).map((x) => x.it);

	if (items.length === 0) {
		throw new AppError('GEN_QUIZ_EMPTY');
	}

	const title = input.prompt.length > 80 ? `${input.prompt.slice(0, 77)}...` : input.prompt;
	const quizId = createQuiz(
		v,
		title,
		{ domains: input.domains ?? null, chatId: input.chatId ?? null, prompt: input.prompt },
		input.model,
		items.map(({ sourceId: _sourceId, ...rest }) => rest)
	);
	return { quizId, requested: total, delivered: items.length };
}
