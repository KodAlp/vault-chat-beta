import { chatWithFallback } from './providers/registry';
import type { ChatMessage } from './providers/types';
import { retrieve } from './retrieve';
import { getMessages } from './chats-db';
import { QuizItems, buildQuizItemsJsonSchema } from './quiz-schema';
import { createQuiz, type NewQuizItem } from './study-db';
import { splitComposition } from './quiz-batch';
import { renderUserSkillsBlock } from './userSkills';
import type { VaultContext } from './vaults';
import { NoSourcesError } from './generate-errors';

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

type ParseResult = { ok: true; items: NewQuizItem[] } | { ok: false; error: string };

/** Rejects items whose source_id isn't one of the ids actually offered — the
 * anti-hallucination check the skill requires — and resolves the winning
 * ones to real source_path/heading_path from the server's own chunk table. */
function parseAndValidate(
	raw: string,
	idToChunk: Map<string, { path: string; heading_path: string }>,
	expectedCount: number
): ParseResult {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, error: 'Model geçerli JSON döndürmedi.' };
	}
	const result = QuizItems.safeParse(json);
	if (!result.success) {
		return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
	}
	const badIds = result.data.items.filter((item) => !idToChunk.has(item.source_id));
	if (badIds.length > 0) {
		return {
			ok: false,
			error: `${badIds.length} sorunun source_id'si sağlanan kaynak kimlikleriyle eşleşmiyor. Sadece S1, S2, ... gibi verilen kimlikleri kullan.`
		};
	}
	if (result.data.items.length !== expectedCount) {
		return {
			ok: false,
			error: `Model ${expectedCount} soru istenirken ${result.data.items.length} soru üretti. Tam olarak ${expectedCount} soru üret.`
		};
	}
	const items: NewQuizItem[] = result.data.items.map((item) => {
		const chunk = idToChunk.get(item.source_id)!;
		return {
			type: item.type,
			question: item.question,
			options: item.options,
			answer: item.answer,
			explanation: item.explanation,
			source_path: chunk.path,
			heading_path: chunk.heading_path
		};
	});
	return { ok: true, items };
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
): Promise<{ quizId: string }> {
	onProgress?.('retrieving');
	input = { ...input, composition: clampComposition(input.composition) };
	const total = input.composition.mc + input.composition.tf + input.composition.open;
	if (total === 0) {
		throw new Error('En az bir soru seçilmeli.');
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

	const { chunks, narrowScope, reason } = await retrieve(v, query, {
		domains: input.domains,
		includedPaths: input.includedPaths,
		k: 12
	});
	if (chunks.length === 0) {
		throw new NoSourcesError(narrowScope, reason);
	}

	// Short id per chunk (S1, S2, ...) instead of a path for the model to
	// copy — see quiz-schema.ts's doc comment. This is the same fix that took
	// report generation from a 0% to a working success rate.
	const idToChunk = new Map(chunks.map((c, i) => [`S${i + 1}`, c]));
	const contextBlock = chunks
		.map(
			(c, i) =>
				`id: S${i + 1}\nsource_path: ${c.path}\nheading_path: ${c.heading_path}\ndepth: ${c.depth}\n\n${c.display_text}`
		)
		.join('\n\n---\n\n');
	const userSkillsBlock = await renderUserSkillsBlock('quiz');

	// One deadline for the whole generation, every batch and every retry
	// included — unchanged from before batching.
	const deadline = AbortSignal.timeout(GENERATION_BUDGET_MS);

	const items: NewQuizItem[] = [];
	const batches = splitComposition(input.composition, QUIZ_ITEMS_PER_BATCH);
	onProgress?.('generating');
	for (const batchComposition of batches) {
		const batchTotal = batchComposition.mc + batchComposition.tf + batchComposition.open;
		const batchSystemPrompt = buildSystemPrompt(batchComposition, contextBlock, userSkillsBlock);
		const format = buildQuizItemsJsonSchema([...idToChunk.keys()], batchTotal);
		// Same "don't repeat" nudge as generate-cards.ts's avoidNote — the
		// full <context> stays available every batch, just steered away
		// from re-covering ground already generated. Soft mitigation, not
		// a guarantee (see that file's comment on source-pool size).
		const avoidNote =
			items.length > 0
				? `\n\nBu sorular zaten üretildi, AYNI SORUYU TEKRAR ÜRETME:\n${items.map((i) => `- ${i.question}`).join('\n')}`
				: '';
		const batchPrompt = `${input.prompt}${avoidNote}`;
		const outputBudget = quizOutputBudget(batchTotal);

		onProgress?.('generating');
		let raw = await callModel(
			input.model,
			batchSystemPrompt,
			batchPrompt,
			format,
			input.provider,
			deadline,
			(ms) => onProgress?.('generating', ms),
			outputBudget
		);
		let parsed = parseAndValidate(raw, idToChunk, batchTotal);

		const MAX_RETRIES = 2;
		for (let attempt = 0; !parsed.ok && attempt < MAX_RETRIES; attempt++) {
			onProgress?.('retrying');
			const retryPrompt = `${batchPrompt}\n\nÖnceki cevabın geçersizdi: ${parsed.error}\nSADECE geçerli JSON döndür.`;
			raw = await callModel(
				input.model,
				batchSystemPrompt,
				retryPrompt,
				format,
				input.provider,
				deadline,
				(ms) => onProgress?.('retrying', ms),
				outputBudget
			);
			parsed = parseAndValidate(raw, idToChunk, batchTotal);
		}

		// Same partial-accept policy as generate-cards.ts: a batch that
		// never validates even after retries is skipped, not treated as a
		// reason to discard every question generated so far. Zero
		// questions across every batch, below, is still a hard failure.
		// A thrown exception from callModel itself (network/timeout/abort)
		// is NOT caught here — it still propagates immediately, same as
		// before batching.
		if (parsed.ok) items.push(...parsed.items);
	}

	if (items.length === 0) {
		throw new Error('Sınav üretilemedi: hiçbir batch geçerli soru üretemedi.');
	}

	const title = input.prompt.length > 80 ? `${input.prompt.slice(0, 77)}...` : input.prompt;
	const quizId = createQuiz(
		v,
		title,
		{ domains: input.domains ?? null, chatId: input.chatId ?? null, prompt: input.prompt },
		input.model,
		items
	);
	return { quizId };
}
