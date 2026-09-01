import { chatWithFallback } from './providers/registry';
import type { ChatMessage } from './providers/types';
import { retrieve } from './retrieve';
import { getMessages } from './chats-db';
import { buildCardsJsonSchema } from './cards-schema';
import { parseAndValidateCards } from './cards-validate';
import { createDeck } from './study-db';
import { renderUserSkillsBlock } from './userSkills';
import type { VaultContext } from './vaults';
import { NoSourcesError } from './generate-errors';

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

const QUERY_EXTRACT_SYSTEM_PROMPT =
	'Kullanıcının bilgi kartı isteğinden, sadece KONUYU özetleyen kısa bir arama sorgusu çıkar. "kart oluştur", "flashcard üret" gibi talimat kelimelerini ATLA, sadece konuyu yaz. Tek satır, sadece sorgu metni, başka hiçbir şey yazma.';

/** Same non-determinism fix as generate-quiz.ts's extractTopicalQuery —
 * temperature:0 is load-bearing, not cosmetic (see that file's comment). */
async function extractTopicalQuery(prompt: string, model: string, provider?: string): Promise<string> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: QUERY_EXTRACT_SYSTEM_PROMPT },
		{ role: 'user', content: prompt }
	];
	let text = '';
	const signal = new AbortController().signal;
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
	onTick?: (elapsedMs: number) => void
): Promise<string> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt }
	];
	let text = '';
	const signal = new AbortController().signal;
	const startedAt = Date.now();
	const timer = onTick ? setInterval(() => onTick(Date.now() - startedAt), HEARTBEAT_INTERVAL_MS) : undefined;
	try {
		for await (const event of chatWithFallback(
			'flashcards',
			{ model, messages, think: false, format, temperature: 0.3 },
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

	// Non-overridable, appended after any user skills — see userSkills.ts and
	// the user-skills skill doc's "assembly order" section.
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

	const { chunks, narrowScope } = await retrieve(v, query, {
		domains: input.domains,
		includedPaths: input.includedPaths,
		k: 12
	});
	if (chunks.length === 0) {
		throw new NoSourcesError(narrowScope);
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
	const systemPrompt = buildSystemPrompt(input.count, contextBlock, userSkillsBlock);
	const format = buildCardsJsonSchema([...idToChunk.keys()]);

	onProgress?.('generating');
	let raw = await callModel(input.model, systemPrompt, input.prompt, format, input.provider, (ms) =>
		onProgress?.('generating', ms)
	);

	onProgress?.('validating');
	let parsed = parseAndValidateCards(raw, idToChunk);

	const MAX_RETRIES = 2;
	for (let attempt = 0; !parsed.ok && attempt < MAX_RETRIES; attempt++) {
		onProgress?.('retrying');
		const retryPrompt = `${input.prompt}\n\nÖnceki cevabın geçersizdi: ${parsed.error}\nSADECE geçerli JSON döndür.`;
		raw = await callModel(input.model, systemPrompt, retryPrompt, format, input.provider, (ms) =>
			onProgress?.('retrying', ms)
		);
		parsed = parseAndValidateCards(raw, idToChunk);
	}

	if (!parsed.ok) {
		throw new Error(`Kartlar üretilemedi: ${parsed.error}`);
	}

	// The model doesn't reliably respect the requested count (same class of
	// prompt-adherence issue as generate-quiz.ts's MC/TF/open composition) —
	// but unlike quiz composition, a flat card count truncates safely with no
	// semantic loss, so enforce it here rather than leaving it as a loose end.
	const items = parsed.items.slice(0, input.count);

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
