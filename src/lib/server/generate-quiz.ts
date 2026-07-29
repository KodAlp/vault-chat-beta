import { streamChat, type OllamaChatMessage } from './ollama';
import { retrieve } from './retrieve';
import { getMessages } from './chats-db';
import { QuizItems, QUIZ_ITEMS_JSON_SCHEMA } from './quiz-schema';
import { createQuiz, type NewQuizItem } from './study-db';

export interface GenerateQuizInput {
	domains?: string[];
	chatId?: string;
	prompt: string;
	composition: { mc: number; tf: number; open: number };
	/** Skill spec: generation defaults to the user's reasoning model. */
	model: string;
}

export type ProgressStage = 'retrieving' | 'generating' | 'validating' | 'retrying';

const QUERY_EXTRACT_SYSTEM_PROMPT =
	'Kullanıcının test/sınav isteğinden, sadece KONUYU özetleyen kısa bir arama sorgusu çıkar. "test hazırla", "soru üret" gibi talimat kelimelerini ATLA, sadece konuyu yaz. Tek satır, sadece sorgu metni, başka hiçbir şey yazma.';

/**
 * retrieve() embeds the query text directly — an instructional sentence like
 * "... üzerine kısa bir test hazırla" measurably degrades the embedding match
 * versus a clean topical phrase (verified empirically: the exact same prompt
 * through the existing /api/chat domain filter also returned nothing useful).
 * Strip the instruction framing via a quick model call before retrieving.
 */
async function extractTopicalQuery(prompt: string, model: string): Promise<string> {
	const messages: OllamaChatMessage[] = [
		{ role: 'system', content: QUERY_EXTRACT_SYSTEM_PROMPT },
		{ role: 'user', content: prompt }
	];
	let text = '';
	for await (const piece of streamChat(model, messages, false)) {
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
		format: QUIZ_ITEMS_JSON_SCHEMA,
		temperature: 0.3
	})) {
		if (piece.kind === 'content') text += piece.text;
	}
	return text;
}

type ParseResult = { ok: true; items: NewQuizItem[] } | { ok: false; error: string };

/** Rejects items whose source_path isn't one of the chunks actually retrieved
 * and handed to the model — the anti-hallucination check the skill requires. */
function parseAndValidate(raw: string, validPaths: Set<string>): ParseResult {
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
	const badPaths = result.data.items.filter((item) => !validPaths.has(item.source_path));
	if (badPaths.length > 0) {
		return {
			ok: false,
			error: `${badPaths.length} sorunun source_path'i sağlanan kaynaklarla eşleşmiyor (uydurma kaynak).`
		};
	}
	if (result.data.items.length === 0) {
		return { ok: false, error: 'Model hiç soru üretmedi.' };
	}
	return { ok: true, items: result.data.items };
}

function buildSystemPrompt(
	composition: GenerateQuizInput['composition'],
	contextBlock: string
): string {
	const total = composition.mc + composition.tf + composition.open;
	return `Sen bir sınav hazırlama asistanısın. Aşağıdaki <context> bloğu, her biri source_path/heading_path/depth
etiketleriyle işaretlenmiş kaynak parçalarından oluşuyor. SADECE bu parçalardaki bilgiye dayanarak, tam olarak
${total} soruluk bir test hazırla: ${composition.mc} çoktan seçmeli (4 seçenek), ${composition.tf} doğru/yanlış, ${composition.open} açık uçlu.
Context dışında hiçbir bilgi kullanma — context'te olmayan bir konuda soru sorma, kendi bilgin olsa bile.

Kurallar:
- Türkçe yaz. Matematik sadece $...$ (satır içi) veya $$...$$ (blok) içinde, asla çıplak LaTeX.
- Her sorunun source_path alanı, o soruyu hangi kaynak parçasından ürettiysen o parçanın source_path
  etiketinin değeriyle BİREBİR AYNI olmalı — SADECE dosya yolu (örn. "wiki/math/calculus.md"),
  başka hiçbir şey ekleme veya çıkarma.
- heading_path alanı da aynı şekilde ilgili parçanın heading_path etiketinin değeriyle birebir aynı olmalı.
- Çoktan seçmeli sorularda options tam olarak 4 seçenek içermeli, answer bu 4 seçenekten biriyle birebir aynı metin olmalı.
- Doğru/yanlış sorularda answer tam olarak "true" veya "false" olmalı.
- explanation alanı doğru cevabın nedenini 1-3 cümlede açıklamalı.
- Notların seviyesine (depth) uygun zorlukta sorular sor.

<context>
${contextBlock}
</context>`;
}

/**
 * Foreground pipeline — the skill explicitly forbids hidden background model
 * calls here ("the user owns their RAM"), so onProgress is meant to drive a
 * visible progress UI, not a fire-and-forget like title generation.
 */
export async function generateQuiz(
	input: GenerateQuizInput,
	onProgress?: (stage: ProgressStage) => void
): Promise<{ quizId: string }> {
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

	const validPaths = new Set(chunks.map((c) => c.path));
	// Labeled fields, not a bracketed "[path | heading] (depth: x)" citation —
	// the model was copying the whole bracket display format verbatim into
	// source_path instead of extracting just the path (verified empirically).
	// Explicit field labels mirroring the JSON schema's field names fix this.
	const contextBlock = chunks
		.map(
			(c) =>
				`source_path: ${c.path}\nheading_path: ${c.heading_path}\ndepth: ${c.depth}\n\n${c.display_text}`
		)
		.join('\n\n---\n\n');
	const systemPrompt = buildSystemPrompt(input.composition, contextBlock);
	// Faz 4 hook: 'quiz' scope'lu user-skill içeriği (varsa) burada systemPrompt'a
	// eklenecek. user-skills sistemi henüz yok (Faz 4), şimdilik atlanıyor.

	onProgress?.('generating');
	let raw = await callModel(input.model, systemPrompt, input.prompt);

	onProgress?.('validating');
	let parsed = parseAndValidate(raw, validPaths);

	if (!parsed.ok) {
		onProgress?.('retrying');
		const retryPrompt = `${input.prompt}\n\nÖnceki cevabın geçersizdi: ${parsed.error}\nSADECE geçerli JSON döndür, source_path'leri context'ten birebir kopyala.`;
		raw = await callModel(input.model, systemPrompt, retryPrompt);
		parsed = parseAndValidate(raw, validPaths);
	}

	if (!parsed.ok) {
		throw new Error(`Sınav üretilemedi: ${parsed.error}`);
	}

	const title = input.prompt.length > 80 ? `${input.prompt.slice(0, 77)}...` : input.prompt;
	const quizId = createQuiz(
		title,
		{ domains: input.domains ?? null, chatId: input.chatId ?? null, prompt: input.prompt },
		input.model,
		parsed.items
	);
	return { quizId };
}
