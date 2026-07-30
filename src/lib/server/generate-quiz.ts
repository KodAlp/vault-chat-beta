import { chatWithFallback } from './providers/registry';
import type { ChatMessage } from './providers/types';
import { retrieve } from './retrieve';
import { getMessages } from './chats-db';
import { QuizItems, QUIZ_ITEMS_JSON_SCHEMA } from './quiz-schema';
import { createQuiz, type NewQuizItem } from './study-db';
import { renderUserSkillsBlock } from './userSkills';
import type { VaultContext } from './vaults';

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
 *
 * temperature:0 is load-bearing here, not cosmetic: without it this call uses
 * the model's default (non-zero) sampling, so the *same* user prompt can
 * extract a *different* query text on each call — and therefore sometimes
 * find nothing and sometimes find good matches, purely by sampling luck. That
 * inconsistency is what got reported as a suspected race condition; it
 * wasn't concurrency, it was this call being non-deterministic.
 */
async function extractTopicalQuery(prompt: string, model: string): Promise<string> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: QUERY_EXTRACT_SYSTEM_PROMPT },
		{ role: 'user', content: prompt }
	];
	let text = '';
	const signal = new AbortController().signal;
	for await (const event of chatWithFallback('quiz', { model, messages, think: false, temperature: 0 }, signal)) {
		if (event.type === 'text') text += event.text;
	}
	return text.trim() || prompt;
}

async function callModel(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt }
	];
	let text = '';
	const signal = new AbortController().signal;
	for await (const event of chatWithFallback(
		'quiz',
		{ model, messages, think: false, format: QUIZ_ITEMS_JSON_SCHEMA, temperature: 0.3 },
		signal
	)) {
		if (event.type === 'text') text += event.text;
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

/** Exported for /api/skills/preview — lets the settings page show exactly
 * how a scope's system prompt is assembled without a real generation call. */
export function buildSystemPrompt(
	composition: GenerateQuizInput['composition'],
	contextBlock: string,
	userSkillsBlock: string
): string {
	const total = composition.mc + composition.tf + composition.open;
	const taskIntro = `Sen bir sınav hazırlama asistanısın. Aşağıdaki <context> bloğu, her biri source_path/heading_path/depth
etiketleriyle işaretlenmiş kaynak parçalarından oluşuyor. Tam olarak
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
- Her sorunun source_path alanı, o soruyu hangi kaynak parçasından ürettiysen SADECE o parçanın
  KENDİ source_path etiketinin değeriyle BİREBİR AYNI olmalı (dosya yolu, başka hiçbir şey ekleme
  veya çıkarma). Kaynak parçalarının METİN İÇERİĞİNDE geçen başka dosya adları/[[bağlantılar]]
  varsa (örn. bir parça başka bir kaynağa atıfta bulunuyor olabilir) BUNLARI source_path olarak
  KULLANMA — sadece o parçanın en üstündeki source_path etiketini kullan, metnin içinde adı geçen
  değil.
- heading_path alanı da aynı şekilde ilgili parçanın KENDİ heading_path etiketinin değeriyle
  birebir aynı olmalı.
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

	const { chunks } = await retrieve(v, query, { domains: input.domains, k: 12 });
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
	const userSkillsBlock = await renderUserSkillsBlock('quiz');
	const systemPrompt = buildSystemPrompt(input.composition, contextBlock, userSkillsBlock);

	onProgress?.('generating');
	let raw = await callModel(input.model, systemPrompt, input.prompt);

	onProgress?.('validating');
	let parsed = parseAndValidate(raw, validPaths);

	// Two retry attempts, not one — the source_path-confused-with-a-name-
	// mentioned-in-the-text failure mode (a chunk's own text referencing
	// another file) needs more than one nudge to reliably self-correct.
	const MAX_RETRIES = 2;
	for (let attempt = 0; !parsed.ok && attempt < MAX_RETRIES; attempt++) {
		onProgress?.('retrying');
		const retryPrompt = `${input.prompt}\n\nÖnceki cevabın geçersizdi: ${parsed.error}\nSADECE geçerli JSON döndür. source_path, kullandığın kaynak parçasının EN ÜSTÜNDEKİ source_path etiketiyle birebir aynı olmalı — parçanın metin içeriğinde adı geçen başka bir dosya değil.`;
		raw = await callModel(input.model, systemPrompt, retryPrompt);
		parsed = parseAndValidate(raw, validPaths);
	}

	if (!parsed.ok) {
		throw new Error(`Sınav üretilemedi: ${parsed.error}`);
	}

	const title = input.prompt.length > 80 ? `${input.prompt.slice(0, 77)}...` : input.prompt;
	const quizId = createQuiz(
		v,
		title,
		{ domains: input.domains ?? null, chatId: input.chatId ?? null, prompt: input.prompt },
		input.model,
		parsed.items
	);
	return { quizId };
}
