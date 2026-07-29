import { streamChat, type OllamaChatMessage } from './ollama';
import { retrieve } from './retrieve';
import { getMessages } from './chats-db';
import { Cards, CARDS_JSON_SCHEMA } from './cards-schema';
import { createDeck, type NewCard } from './study-db';
import { renderUserSkillsBlock } from './userSkills';
import type { RetrievedChunk } from '$lib/types';

export interface GenerateCardsInput {
	domains?: string[];
	chatId?: string;
	prompt: string;
	count: number;
	/** Skill spec: generation defaults to the user's reasoning model. */
	model: string;
}

export type ProgressStage = 'retrieving' | 'generating' | 'validating' | 'retrying';

const QUERY_EXTRACT_SYSTEM_PROMPT =
	'Kullanıcının bilgi kartı isteğinden, sadece KONUYU özetleyen kısa bir arama sorgusu çıkar. "kart oluştur", "flashcard üret" gibi talimat kelimelerini ATLA, sadece konuyu yaz. Tek satır, sadece sorgu metni, başka hiçbir şey yazma.';

/** Same non-determinism fix as generate-quiz.ts's extractTopicalQuery —
 * temperature:0 is load-bearing, not cosmetic (see that file's comment). */
async function extractTopicalQuery(prompt: string, model: string): Promise<string> {
	const messages: OllamaChatMessage[] = [
		{ role: 'system', content: QUERY_EXTRACT_SYSTEM_PROMPT },
		{ role: 'user', content: prompt }
	];
	let text = '';
	for await (const piece of streamChat(model, messages, false, undefined, { temperature: 0 })) {
		if (piece.kind === 'content') text += piece.text;
	}
	return text.trim() || prompt;
}

async function callModel(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
	const messages: OllamaChatMessage[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt }
	];
	let text = '';
	for await (const piece of streamChat(model, messages, false, undefined, {
		format: CARDS_JSON_SCHEMA,
		temperature: 0.3
	})) {
		if (piece.kind === 'content') text += piece.text;
	}
	return text;
}

type ParseResult = { ok: true; items: NewCard[] } | { ok: false; error: string };

/**
 * Rejects items whose source_path isn't one of the chunks actually retrieved
 * (the anti-hallucination check the skill requires) and, for the ones that
 * pass, derives domain/level from that chunk's own metadata rather than
 * trusting the model to copy them — see cards-schema.ts's comment. This is a
 * deliberate deviation from the skill's literal Card zod spec (documented in
 * the skill doc).
 */
function parseAndValidate(raw: string, chunksByPath: Map<string, RetrievedChunk>): ParseResult {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, error: 'Model geçerli JSON döndürmedi.' };
	}
	const result = Cards.safeParse(json);
	if (!result.success) {
		return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
	}
	const badPaths = result.data.items.filter((item) => !chunksByPath.has(item.source_path));
	if (badPaths.length > 0) {
		return {
			ok: false,
			error: `${badPaths.length} kartın source_path'i sağlanan kaynaklarla eşleşmiyor (uydurma kaynak).`
		};
	}
	if (result.data.items.length === 0) {
		return { ok: false, error: 'Model hiç kart üretmedi.' };
	}
	const items: NewCard[] = result.data.items.map((item) => {
		const chunk = chunksByPath.get(item.source_path)!;
		return {
			front: item.front,
			back: item.back,
			source_path: item.source_path,
			heading_path: item.heading_path,
			domain: chunk.domains[0] ?? 'genel',
			level: chunk.depth
		};
	});
	return { ok: true, items };
}

/** Exported for /api/skills/preview — lets the settings page show exactly
 * how a scope's system prompt is assembled without a real generation call. */
export function buildSystemPrompt(count: number, contextBlock: string, userSkillsBlock: string): string {
	const taskIntro = `Sen bir bilgi kartı (flashcard) hazırlama asistanısın. Aşağıdaki <context> bloğu, her biri
source_path/heading_path/depth etiketleriyle işaretlenmiş kaynak parçalarından oluşuyor. Tam olarak ${count} adet
bilgi kartı hazırla.

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
- Her kartın source_path alanı, o kartı hangi kaynak parçasından ürettiysen SADECE o parçanın
  KENDİ source_path etiketinin değeriyle BİREBİR AYNI olmalı (dosya yolu, başka hiçbir şey ekleme
  veya çıkarma). Kaynak parçalarının METİN İÇERİĞİNDE geçen başka dosya adları/[[bağlantılar]]
  varsa BUNLARI source_path olarak KULLANMA — sadece o parçanın en üstündeki source_path
  etiketini kullan.
- heading_path alanı da aynı şekilde ilgili parçanın KENDİ heading_path etiketinin değeriyle
  birebir aynı olmalı.`;

	return [taskIntro, userSkillsBlock, invariants, `<context>\n${contextBlock}\n</context>`]
		.filter(Boolean)
		.join('\n\n');
}

/** Foreground pipeline — mirrors generate-quiz.ts exactly (see that file's
 * comment on why onProgress drives a visible UI, never a hidden call). */
export async function generateCards(
	input: GenerateCardsInput,
	onProgress?: (stage: ProgressStage) => void
): Promise<{ deckId: string }> {
	onProgress?.('retrieving');

	const topicalQuery = await extractTopicalQuery(input.prompt, input.model);
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

	const chunks = await retrieve(query, { domains: input.domains, k: 12 });
	if (chunks.length === 0) {
		throw new Error('Bu kapsamda kütüphanede yeterli kaynak yok.');
	}

	const chunksByPath = new Map(chunks.map((c) => [c.path, c]));
	const contextBlock = chunks
		.map(
			(c) =>
				`source_path: ${c.path}\nheading_path: ${c.heading_path}\ndepth: ${c.depth}\n\n${c.display_text}`
		)
		.join('\n\n---\n\n');
	const userSkillsBlock = await renderUserSkillsBlock('flashcards');
	const systemPrompt = buildSystemPrompt(input.count, contextBlock, userSkillsBlock);

	onProgress?.('generating');
	let raw = await callModel(input.model, systemPrompt, input.prompt);

	onProgress?.('validating');
	let parsed = parseAndValidate(raw, chunksByPath);

	const MAX_RETRIES = 2;
	for (let attempt = 0; !parsed.ok && attempt < MAX_RETRIES; attempt++) {
		onProgress?.('retrying');
		const retryPrompt = `${input.prompt}\n\nÖnceki cevabın geçersizdi: ${parsed.error}\nSADECE geçerli JSON döndür. source_path, kullandığın kaynak parçasının EN ÜSTÜNDEKİ source_path etiketiyle birebir aynı olmalı — parçanın metin içeriğinde adı geçen başka bir dosya değil.`;
		raw = await callModel(input.model, systemPrompt, retryPrompt);
		parsed = parseAndValidate(raw, chunksByPath);
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
		title,
		{ domains: input.domains ?? null, chatId: input.chatId ?? null, prompt: input.prompt },
		input.model,
		items
	);
	return { deckId };
}
