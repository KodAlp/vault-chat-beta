import { Marp } from '@marp-team/marp-core';
import { chatWithFallback } from './providers/registry';
import type { ChatMessage } from './providers/types';
import { retrieve } from './retrieve';
import { getMessages } from './chats-db';
import { Slides, buildSlidesJsonSchema } from './slides-schema';
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

async function extractTopicalQuery(prompt: string, model: string, provider?: string): Promise<string> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: QUERY_EXTRACT_SYSTEM_PROMPT },
		{ role: 'user', content: prompt }
	];
	let text = '';
	const signal = new AbortController().signal;
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

type ParseResult = { ok: true; slides: NewSlide[] } | { ok: false; error: string };

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
	const slides: NewSlide[] = result.data.slides.map((s) => ({
		content_markdown: s.content_markdown,
		source_path: idToPath.get(s.source_id)!
	}));
	return { ok: true, slides };
}

export function buildSystemPrompt(contextBlock: string, userSkillsBlock: string): string {
	const taskIntro = `Sen bir sunum (slayt) hazırlama asistanısın. Aşağıdaki <context> bloğu, her biri kısa bir
kimlikle (id: S1, S2, ...) ve source_path/heading_path/depth etiketleriyle işaretlenmiş kaynak
parçalarından oluşuyor. Bu kaynaklara dayanarak 3-20 slaytlık bir sunum hazırla. Her slaytın
content_markdown alanı KISA madde işaretleri (bullet point) içermeli, uzun paragraflar değil — bir
slayt ekranda gösterilecek, okunacak bir makale değil.`;

	const invariants = `Kurallar:
- SADECE <context> bloğundaki bilgiye dayanarak slaytlar hazırla. Context dışında hiçbir bilgi kullanma.
- Türkçe yaz. Her slaytta en fazla 4-6 kısa madde işareti olsun, uzun cümleler kurma.
- content_markdown'da bir başlık satırı (# ile başlayan) ve altında madde işaretleri (- ile başlayan) kullan.
- Matematik sadece $...$ (satır içi) veya $$...$$ (blok) içinde, asla çıplak LaTeX.
- content_markdown içinde yalnız "---" karakterlerinden oluşan bir satır KULLANMA (bu slayt ayracı
  olarak yorumlanır) — yatay çizgi gerekiyorsa bunun yerine düzyazıda belirt.
- source_id, o slaytı hangi kaynak parçasından ürettiysen o parçanın id'si olmalı — sadece S1, S2,
  ... gibi verilen kimlikleri kullan, asla dosya yolu yazma.`;

	return [taskIntro, userSkillsBlock, invariants, `<context>\n${contextBlock}\n</context>`]
		.filter(Boolean)
		.join('\n\n');
}

const INLINE_MATH_RE = /\$\$([\s\S]*?)\$\$|\$([^$\n]+?)\$/g;

/**
 * marp-core's bundled KaTeX plugin (a different implementation from this
 * app's own @vscode/markdown-it-katex, used by markdown.ts for report/chat)
 * requires NO whitespace immediately inside inline `$...$` delimiters to
 * recognize them as math — `$x^2$` renders, `$ x^2 $` silently falls through
 * as literal text. Verified empirically against the real package: block
 * `$$...$$` tolerates interior spaces fine, only inline is strict. Local
 * models (qwen3:8b observed in practice) routinely pad both sides with a
 * space, so this trim is load-bearing, not defensive — without it, math in
 * slides silently renders as raw dollar-sign text with no error anywhere.
 */
function trimMathDelimiterWhitespace(text: string): string {
	return text.replace(INLINE_MATH_RE, (full, display: string | undefined, inline: string | undefined) => {
		if (display !== undefined) return `$$${display.trim()}$$`;
		if (inline !== undefined) return `$${inline.trim()}$`;
		return full;
	});
}

/** Marpit's slide separator ("\n---\n" between blank lines) requires the
 * concatenated deck to be built with real newlines, not string interpolation
 * that could accidentally merge a slide's trailing content into the next
 * separator line. */
function buildMarpDeck(slides: NewSlide[]): string {
	const header = '---\nmarp: true\n---\n\n';
	const body = slides
		.map((s) => trimMathDelimiterWhitespace(s.content_markdown.trim()))
		.join('\n\n---\n\n');
	return header + body;
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

	const { chunks, narrowScope } = await retrieve(v, query, {
		domains: input.domains,
		includedPaths: input.includedPaths,
		k: 12
	});
	if (chunks.length === 0) {
		throw new NoSourcesError(narrowScope);
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

	onProgress?.('generating');
	let raw = await callModel(input.model, systemPrompt, input.prompt, format, input.provider, (ms) =>
		onProgress?.('generating', ms)
	);

	onProgress?.('validating');
	let parsed = parseAndValidate(raw, idToPath);

	const MAX_RETRIES = 2;
	for (let attempt = 0; !parsed.ok && attempt < MAX_RETRIES; attempt++) {
		onProgress?.('retrying');
		const retryPrompt = `${input.prompt}\n\nÖnceki cevabın geçersizdi: ${parsed.error}\nSADECE geçerli JSON döndür.`;
		raw = await callModel(input.model, systemPrompt, retryPrompt, format, input.provider, (ms) =>
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
