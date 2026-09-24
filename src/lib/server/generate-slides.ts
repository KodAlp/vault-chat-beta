import { Marp } from '@marp-team/marp-core';
import { chatWithFallback } from './providers/registry';
import type { ChatMessage } from './providers/types';
import { retrieve } from './retrieve';
import { getMessages } from './chats-db';
import { Slides, buildSlidesJsonSchema, type SlideDiagramT } from './slides-schema';
import { SLIDES_THEME_CSS } from './slides-theme';
import { buildMarpDeck } from './slides-deck';
import { createSlideDeck, type NewSlide } from './study-db';
import { renderUserSkillsBlock } from './userSkills';
import type { VaultContext } from './vaults';
import { NoSourcesError } from './generate-errors';

export interface GenerateSlidesInput {
	domains?: string[];
	chatId?: string;
	prompt: string;
	model: string;
	/** See ChatRequestBody.provider's doc comment ($lib/types.ts) — same
	 * optional pin, threaded into every chatWithFallback call below. */
	provider?: string;
	/** Chat's own source-tree scope selection — see ChatRequestBody.includedPaths. */
	includedPaths?: string[];
}

export type ProgressStage = 'retrieving' | 'generating' | 'validating' | 'retrying';

const QUERY_EXTRACT_SYSTEM_PROMPT =
	'Kullanıcının slayt isteğinden, sadece KONUYU özetleyen kısa bir arama sorgusu çıkar. "slayt hazırla", "sunum yap" gibi talimat kelimelerini ATLA, sadece konuyu yaz. Tek satır, sadece sorgu metni, başka hiçbir şey yazma.';

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
		'slides',
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
	onTick?: (elapsedMs: number) => void
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
			'slides',
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

/** result.data.slides (zod-validated, carries `diagram`) plus the resolved
 * source_path — a superset of NewSlide that both createSlideDeck (DB write,
 * which only reads NewSlide's own fields) and buildMarpDeck (which also
 * needs `diagram`) can consume without a second mapping pass. */
type ValidatedSlide = NewSlide & { diagram?: SlideDiagramT };

type ParseResult = { ok: true; slides: ValidatedSlide[] } | { ok: false; error: string };

function parseAndValidate(raw: string, idToPath: Map<string, string>): ParseResult {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, error: 'Model geçerli JSON döndürmedi.' };
	}
	const result = Slides.safeParse(json);
	if (!result.success) {
		return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
	}
	const badIds = result.data.slides.filter((s) => !idToPath.has(s.source_id));
	if (badIds.length > 0) {
		return {
			ok: false,
			error: `${badIds.length} slaytın source_id'si sağlanan kaynak kimlikleriyle eşleşmiyor. Sadece S1, S2, ... gibi verilen kimlikleri kullan.`
		};
	}
	if (result.data.slides.length === 0) {
		return { ok: false, error: 'Model hiç slayt üretmedi.' };
	}
	const slides: ValidatedSlide[] = result.data.slides.map((s) => ({
		layout: s.layout,
		heading: s.heading,
		content_markdown: s.content_markdown,
		notes: s.notes ?? null,
		diagram: s.diagram,
		source_path: idToPath.get(s.source_id)!
	}));
	return { ok: true, slides };
}

export function buildSystemPrompt(contextBlock: string, userSkillsBlock: string): string {
	const taskIntro = `Sen bir sunum (slayt) hazırlama asistanısın. Aşağıdaki <context> bloğu, her biri kısa bir
kimlikle (id: S1, S2, ...) ve source_path/heading_path/depth etiketleriyle işaretlenmiş kaynak
parçalarından oluşuyor. Bu kaynaklara dayanarak 3-20 slaytlık bir sunum hazırla. Her slayt bir
düzen (layout), bir başlık (heading) ve bir gövde (content_markdown) taşır — gövde ekranda
gösterilecek, okunacak bir makale değil.`;

	const invariants = `Kurallar:
- SADECE <context> bloğundaki bilgiye dayanarak slaytlar hazırla. Context dışında hiçbir bilgi kullanma.
- Türkçe yaz.
- layout altı değerden biri olmalı, her birinin gövdesi farklı biçimlenir:
  - "title": sunumun açılış ya da yeni bir bölüme geçiş slaytı. Gövde tek kısa bir alt başlık/tanıtım
    cümlesi olsun, madde işareti YOK.
  - "bullets": standart bilgi slaytı. Gövdede en fazla 4-6 kısa madde işareti (- ile başlayan) olsun,
    uzun cümleler kurma.
  - "two-column": "bullets" ile aynı, yalnızca daha uzun bir liste iki sütuna bölünecek şekilde
    gösterilir — 6-10 kısa madde kullanabilirsin.
  - "quote": kaynaktan alıntılanan TEK bir cümle/tanım. Gövde yalnızca "> " ile başlayan bir Markdown
    alıntısı olsun, madde işareti YOK.
  - "code": bir kod örneği. Gövde bir Markdown kod bloğu (\`\`\` ile) + en fazla 1-2 açıklama cümlesi
    olsun.
  - "diagram": bir süreç/ilişki anlatımı (adımlar, akış, döngü). content_markdown'u yine de
    kısa madde işaretleriyle yaz (diyagram üretilemezse gösterilecek yedek budur) AMA ayrıca
    diagram alanını doldur: diagram.nodes en az 1 en fazla 8 öğe, her biri {id, label} (id kısa
    bir kod, örn. "n1"; label ekranda görünecek kısa metin, en fazla birkaç kelime). diagram.edges
    her biri {from, to, label?} — from/to, nodes içindeki bir id olmalı, adımlar arasındaki oku
    temsil eder (label isteğe bağlı, ok üstünde görünür). nodes dizisini akışın doğal sırasıyla
    yaz (ilk adım ilk eleman), ardışık adımlar arasına bir kenar ekle.
  - İLK slaytı her zaman "title" yap. Aradan sonra ÇOĞUNLUKLA "bullets" kullan ama konu uygunsa
    "quote"/"two-column"/"code"/"diagram"ı da kullan — bütün sunumu tek düzende yazma.
- content_markdown'a heading'i TEKRAR YAZMA — heading ayrı bir alan, gövdeye yalnızca o slaytın
  içeriğini yaz.
- notes alanı isteğe bağlı: sunucuyu yapan kişiye (konuşmacıya) sözlü anlatım için kısa bir not,
  ekranda GÖSTERİLMEZ. Gerekmiyorsa boş bırak.
- Matematik sadece $...$ (satır içi) veya $$...$$ (blok) içinde, asla çıplak LaTeX.
- content_markdown içinde yalnız "---" karakterlerinden oluşan bir satır KULLANMA (bu slayt ayracı
  olarak yorumlanır) — yatay çizgi gerekiyorsa bunun yerine düzyazıda belirt.
- source_id, o slaytı hangi kaynak parçasından ürettiysen o parçanın id'si olmalı — sadece S1, S2,
  ... gibi verilen kimlikleri kullan, asla dosya yolu yazma.`;

	return [taskIntro, userSkillsBlock, invariants, `<context>\n${contextBlock}\n</context>`]
		.filter(Boolean)
		.join('\n\n');
}

export async function generateSlides(
	v: VaultContext,
	input: GenerateSlidesInput,
	onProgress?: (stage: ProgressStage, elapsedMs?: number) => void
): Promise<{ slideDeckId: string }> {
	onProgress?.('retrieving');

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
	// copy — see slides-schema.ts's doc comment.
	const idToPath = new Map(chunks.map((c, i) => [`S${i + 1}`, c.path]));
	const contextBlock = chunks
		.map(
			(c, i) =>
				`id: S${i + 1}\nsource_path: ${c.path}\nheading_path: ${c.heading_path}\ndepth: ${c.depth}\n\n${c.display_text}`
		)
		.join('\n\n---\n\n');
	const userSkillsBlock = await renderUserSkillsBlock('slides');
	const systemPrompt = buildSystemPrompt(contextBlock, userSkillsBlock);
	const format = buildSlidesJsonSchema([...idToPath.keys()]);

	// One deadline for the whole generation, retries included.
	const deadline = AbortSignal.timeout(GENERATION_BUDGET_MS);

	onProgress?.('generating');
	let raw = await callModel(input.model, systemPrompt, input.prompt, format, input.provider, deadline, (ms) =>
		onProgress?.('generating', ms)
	);

	onProgress?.('validating');
	let parsed = parseAndValidate(raw, idToPath);

	const MAX_RETRIES = 2;
	for (let attempt = 0; !parsed.ok && attempt < MAX_RETRIES; attempt++) {
		onProgress?.('retrying');
		const retryPrompt = `${input.prompt}\n\nÖnceki cevabın geçersizdi: ${parsed.error}\nSADECE geçerli JSON döndür.`;
		raw = await callModel(input.model, systemPrompt, retryPrompt, format, input.provider, deadline, (ms) =>
			onProgress?.('retrying', ms)
		);
		parsed = parseAndValidate(raw, idToPath);
	}

	if (!parsed.ok) {
		throw new Error(`Sunum üretilemedi: ${parsed.error}`);
	}

	// Rendered ONCE, server-side, at generation time — not per-view, not
	// client-side. Marpit's pagination logic expects to own the whole
	// ----delimited document in a single .render() call, not be invoked once
	// per slide. math:'katex' is explicit (not marp-core's mathjax default)
	// to match this app's KaTeX-based rendering elsewhere and avoid pulling
	// in a second math runtime.
	const marp = new Marp({ math: 'katex' });
	// F13-2 (Aşama 9): registered fresh on this per-call `marp` instance —
	// cheap (a themeSet is just a Map, this call parses ~150 lines of CSS
	// once) and avoids any cross-request module-level mutable state.
	marp.themeSet.add(SLIDES_THEME_CSS);
	const deck = buildMarpDeck(parsed.slides);
	const { html, css } = marp.render(deck);

	const title = input.prompt.length > 80 ? `${input.prompt.slice(0, 77)}...` : input.prompt;
	const slideDeckId = createSlideDeck(
		v,
		title,
		{ domains: input.domains ?? null, chatId: input.chatId ?? null, prompt: input.prompt },
		input.model,
		parsed.slides,
		{ html, css }
	);
	return { slideDeckId };
}
