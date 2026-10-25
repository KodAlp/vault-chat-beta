import { chatWithFallback } from './providers/registry';
import type { ChatMessage } from './providers/types';
import { retrieve } from './retrieve';
import { getMessages } from './chats-db';
import { buildCardsJsonSchema } from './cards-schema';
import { parseAndValidateCards } from './cards-validate';
import { createDeck, type NewCard } from './study-db';
import { renderUserSkillsBlock } from './userSkills';
import type { VaultContext } from './vaults';
import { NoSourcesError, assertNoEmbeddingIssue } from './generate-errors';
import { AppError } from './app-error';

export interface GenerateCardsInput {
	domains?: string[];
	chatId?: string;
	prompt: string;
	count: number;
	/** Skill spec: generation defaults to the user's reasoning model. */
	model: string;
	/** See ChatRequestBody.provider's doc comment ($lib/types.ts) — same
	 * optional pin, threaded into every chatWithFallback call below. */
	provider?: string;
	/** Chat's own source-tree scope selection — see ChatRequestBody.includedPaths. */
	includedPaths?: string[];
}

export type ProgressStage = 'retrieving' | 'generating' | 'validating' | 'retrying';

/** Same reasoning as generate-quiz.ts's clampComposition: the client's own
 * <input max="30"> only stops the spinner arrows, not typed values, and the
 * server must never trust client-side validation alone. */
function clampCount(count: number): number {
	return Math.max(1, Math.min(30, Math.round(count) || 1));
}

/**
 * Batching (fixes the local-model quality-collapse bug): a single call used
 * to ask for up to 30 cards via a grammar that FORBIDS returning fewer
 * (cards-schema.ts's minItems === maxItems), so the model had to keep
 * producing structured JSON with no room to stop even as quality degraded
 * near the end of its context window. Splitting into small batches means no
 * single decode is ever asked for more than CARDS_PER_BATCH cards — the
 * grammar's "must keep going" pressure now caps out at a size a local model
 * can actually sustain quality across, and a batch that goes bad only costs
 * that batch (see the partial-accept loop in generateCards below), not the
 * whole deck.
 */
const CARDS_PER_BATCH = 5;

/**
 * A generous ceiling against a runaway decode (see GENERATION_BUDGET_MS's
 * doc comment for what that guards against at the whole-request level; this
 * is the same idea per-call), not a tuned per-item allowance. ~350
 * tokens/card (front + back + source_id + JSON structure) is an
 * ENGINEERING ESTIMATE, not a measured number — deliberately rounded up.
 * At CARDS_PER_BATCH's size this stays far below the num_ctx headroom left
 * over from the prompt's own context block (~7-9k tokens at k=12, see
 * select-chunks.ts), so it should only ever bind on a genuinely runaway
 * response, not a normal one.
 */
function cardsOutputBudget(batchSize: number): number {
	return 400 + batchSize * 350;
}

const QUERY_EXTRACT_SYSTEM_PROMPT =
	'Kullanıcının bilgi kartı isteğinden, sadece KONUYU özetleyen kısa bir arama sorgusu çıkar. "kart oluştur", "flashcard üret" gibi talimat kelimelerini ATLA, sadece konuyu yaz. Tek satır, sadece sorgu metni, başka hiçbir şey yazma.';

const QUERY_EXTRACT_BUDGET_MS = 60_000;

/** Same non-determinism fix as generate-quiz.ts's extractTopicalQuery —
 * temperature:0 is load-bearing, not cosmetic (see that file's comment). */
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
		'flashcards',
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
			'flashcards',
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
export function buildSystemPrompt(count: number, contextBlock: string, userSkillsBlock: string): string {
	const taskIntro = `Sen bir bilgi kartı (flashcard) hazırlama asistanısın. Aşağıdaki <context> bloğu, her biri kısa
bir kimlikle (id: S1, S2, ...) ve source_path/heading_path/depth etiketleriyle işaretlenmiş kaynak
parçalarından oluşuyor. Tam olarak ${count} adet bilgi kartı hazırla.

- "front" alanı bir HATIRLATMA İPUCU olmalı, trivia değil: "Laplace dönüşümünün yakınsama
  bölgesi neyi belirler?" YAZ, "ROC nedir?" YAZMA. Kartı gören kişi, cevabı hatırlamaya
  zorlanmalı — soru doğrudan tanımı tekrar etmemeli.
- "back" alanı front'un cevabı: tanım, türetim özeti veya somut sonuç. Kısa ve öz, ama eksiksiz
  (self-contained — kart tek başına anlaşılır olmalı).`;

	// Non-overridable, appended after any user skills — see userSkills.ts's assembly order.
	const invariants = `Kurallar:
- SADECE <context> bloğundaki bilgiye dayanarak kart üret. Context dışında hiçbir bilgi
  kullanma — context'te olmayan bir konuda kart üretme.
- Türkçe yaz. Matematik sadece $...$ (satır içi) veya $$...$$ (blok) içinde, asla çıplak LaTeX.
- Her kartın source_id alanı, o kartı hangi kaynak parçasından ürettiysen o parçanın id'si olmalı
  — sadece S1, S2, ... gibi verilen kimlikleri kullan, asla dosya yolu yazma.`;

	return [taskIntro, userSkillsBlock, invariants, `<context>\n${contextBlock}\n</context>`]
		.filter(Boolean)
		.join('\n\n');
}

/** Foreground pipeline — mirrors generate-quiz.ts exactly (see that file's
 * comment on why onProgress drives a visible UI, never a hidden call). */
export async function generateCards(
	v: VaultContext,
	input: GenerateCardsInput,
	onProgress?: (stage: ProgressStage, elapsedMs?: number) => void
): Promise<{ deckId: string }> {
	onProgress?.('retrieving');
	input = { ...input, count: clampCount(input.count) };

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

	// keywordQuery: only the topic, not topic + summary — the keyword fallback (FTS-only mode, or an embedding
	// issue) ANDs every term, so the long summary tail would make it match nothing. See retrieve.ts.
	const retrieved = await retrieve(v, query, {
		keywordQuery: topicalQuery,
		domains: input.domains,
		includedPaths: input.includedPaths,
		k: 12
	});
	assertNoEmbeddingIssue(retrieved);
	const { chunks, narrowScope, reason } = retrieved;
	if (chunks.length === 0) {
		throw new NoSourcesError(narrowScope, reason);
	}

	// Short id per chunk (S1, S2, ...) instead of a path for the model to
	// copy — see cards-schema.ts's doc comment. This is what fixed report
	// generation's 0% success rate; cards had the identical failure.
	const idToChunk = new Map(chunks.map((c, i) => [`S${i + 1}`, c]));
	const contextBlock = chunks
		.map(
			(c, i) =>
				`id: S${i + 1}\nsource_path: ${c.path}\nheading_path: ${c.heading_path}\ndepth: ${c.depth}\n\n${c.display_text}`
		)
		.join('\n\n---\n\n');
	const userSkillsBlock = await renderUserSkillsBlock('flashcards');

	// One deadline for the whole generation, every batch and every retry
	// included — unchanged from before batching.
	const deadline = AbortSignal.timeout(GENERATION_BUDGET_MS);

	const items: NewCard[] = [];
	let remaining = input.count;
	onProgress?.('generating');
	while (remaining > 0) {
		const batchSize = Math.min(CARDS_PER_BATCH, remaining);
		const batchSystemPrompt = buildSystemPrompt(batchSize, contextBlock, userSkillsBlock);
		const format = buildCardsJsonSchema([...idToChunk.keys()], batchSize);
		// Batches after the first get a short "don't repeat these" nudge —
		// the same full <context> stays available every batch (all k=12
		// chunks), just steered away from re-covering ground already
		// generated. A soft mitigation, not a guarantee: with a small
		// source pool (select-chunks.ts's MAX_CHUNKS_PER_FILE can leave as
		// few as 4 distinct files across 12 chunks) some topical overlap
		// across batches is still possible.
		const avoidNote =
			items.length > 0
				? `\n\nBu kartlar zaten üretildi, AYNI KARTI TEKRAR ÜRETME:\n${items.map((c) => `- ${c.front}`).join('\n')}`
				: '';
		const batchPrompt = `${input.prompt}${avoidNote}`;
		const outputBudget = cardsOutputBudget(batchSize);

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
		let parsed = parseAndValidateCards(raw, idToChunk, batchSize);

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
			parsed = parseAndValidateCards(raw, idToChunk, batchSize);
		}

		// A batch that never produced a valid response even after retries
		// moves on to the next batch rather than discarding everything
		// accumulated so far — the fix for "1 bad item out of 30 discards
		// the whole deck". Only a total loss (zero cards across every
		// batch) below is a hard failure. This does NOT apply to a thrown
		// exception (network/timeout/abort) from callModel itself — that
		// still propagates immediately and ends the generation with
		// nothing persisted, same as before batching (see commit 612d3cd:
		// the deadline must actually end the run, not be swallowed here).
		if (parsed.ok) items.push(...parsed.items);
		remaining -= batchSize;
	}

	if (items.length === 0) {
		throw new AppError('GEN_CARDS_EMPTY');
	}

	const title = input.prompt.length > 80 ? `${input.prompt.slice(0, 77)}...` : input.prompt;
	const deckId = createDeck(
		v,
		title,
		{ domains: input.domains ?? null, chatId: input.chatId ?? null, prompt: input.prompt },
		input.model,
		items
	);
	return { deckId };
}
