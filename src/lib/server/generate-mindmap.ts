import { chatWithFallback } from './providers/registry';
import type { ChatMessage } from './providers/types';
import { retrieve } from './retrieve';
import { getMessages } from './chats-db';
import { buildMindMapTreeJsonSchema } from './mindmap-schema';
import {
	parseAndValidateMindMap,
	assessMindMapQuality,
	type CitedChunk
} from './mindmap-validate';
import { createMindMap } from './study-db';
import { renderUserSkillsBlock } from './userSkills';
import type { VaultContext } from './vaults';
import { NoSourcesError, assertNoEmbeddingIssue } from './generate-errors';
import { AppError } from './app-error';
import { logAppEvent } from './app-log';
import { getLibrarySettings } from './library-read';
import { DEFAULT_ALLOWED_LANGUAGES } from './prompt';

export interface GenerateMindMapInput {
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

const QUERY_EXTRACT_BUDGET_MS = 60_000;

const QUERY_EXTRACT_SYSTEM_PROMPT =
	'Kullanıcının zihin haritası isteğinden, sadece KONUYU özetleyen kısa bir arama sorgusu çıkar. "zihin haritası çıkar", "haritala" gibi talimat kelimelerini ATLA, sadece konuyu yaz. Tek satır, sadece sorgu metni, başka hiçbir şey yazma.';

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
		'mindmap',
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
 * retry — not a per-call limit, so the retries cannot multiply it.
 *
 * Every generator used to build `new AbortController().signal` and never
 * abort it, which meant nothing could stop a run. Ollama's own timeouts do
 * not help here: idleMs only fires when tokens STOP arriving, and a model
 * that degenerates into repetition keeps emitting them. A real run was
 * observed spending 28 minutes inside a single call and holding Ollama
 * hostage the whole time — no other generation, and no chat, could run.
 *
 * 12 minutes is deliberately generous: healthy runs on this hardware land
 * between 90s and ~10 minutes (qwen3:8b with 27 of 37 layers on the GPU).
 * The point is that the run ends, not that it ends quickly.
 */
const GENERATION_BUDGET_MS = 12 * 60_000;

/** Ollama's own firstTokenMs budget now covers a cold model load + a large
 * JSON-schema-constrained decode (up to 300s, see providers.json) — long
 * enough that a silent "generating" spinner reads as hung even when the
 * request is healthy. `onTick` fires on a fixed wall-clock interval
 * (independent of whether any bytes have actually arrived yet) so the
 * caller can surface a live "still working" signal regardless of how much
 * of that time is model-load vs. decode. */
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
			'mindmap',
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

export function buildSystemPrompt(
	contextBlock: string,
	userSkillsBlock: string,
	language: string
): string {
	// Placed LAST in the assembled prompt, after the context block, not first.
	// First was the obvious choice and it demonstrably did not work: two live
	// runs came back entirely in English from a Türkçe-only vault, because the
	// retrieved chunks are English and the model mirrors whatever is nearest.
	// userSkills.ts already documents the reason it works better at the end —
	// "local models weight later instructions more heavily", which is why the
	// highest-priority user skill is rendered last there too.
	//
	// The language itself comes from the vault's own
	// LibrarySettings.allowedLanguages rather than being hardcoded — chat has
	// respected that setting since the CJK-leak fix; the generators never did.
	const closingRules = `SON VE EN ÖNEMLİ KURALLAR:
1. ÇIKTININ TAMAMI ${language} DİLİNDE OLMALI. Yukarıdaki kaynaklar İngilizce olsa bile sen
   ${language} yazacaksın. Her "label" ve her "summary" ${language} olmalı; İngilizce bir
   cevap geçersizdir. Terimleri ${language}'ye çevir: "Chain rule" değil "Zincir kuralı",
   "Limits and Continuity" değil "Limitler ve süreklilik".
2. Hiçbir "summary" haritadan, kaynaklardan ya da bu talimatlardan bahsetmez. Sadece kavramı
   açıklar. "Bu zihin haritası birden fazla kaynağı birleştirir" gibi bir cümle YASAK.`;

	const taskIntro = `Sen bir KAVRAM HARİTASI çıkarma asistanısın. Aşağıdaki <context> bloğu, her biri kısa bir
kimlikle (id: S1, S2, ...) işaretlenmiş kaynak parçalarından oluşuyor. Bu kaynaklara dayanarak
konuyu bir AĞAÇ olarak çıkar.

"root" kullanıcının sorduğu konudur:
- "label": konunun adı.
- "summary": KONUNUN TANIMI. Konuyu bilmeyen birine "bu nedir?" sorusunun cevabı.
  DOĞRU: {"label": "Türev", "summary": "Bir fonksiyonun bir noktadaki anlık değişim oranı."}
  YANLIŞ: "Farklı kaynaklardan derlenen temel kavramlar ve uygulamalar." — bu bir tanım değil,
  haritanın kendisi hakkında bir cümle. Haritadan, kaynaklardan ya da bu talimatlardan ASLA
  bahsetme; sadece konuyu tanımla.

"branches" konuyu oluşturan 3-6 ana başlıktır (örn. türev için "Türevin temelleri",
"Türev alma kuralları", "Kısmi türevler", "Uygulamalar"). Her dalın altındaki "children" o
başlığı oluşturan alt kavramlar/anahtar kelimelerdir (örn. "Türev alma kuralları" altında
"Toplamın türevi", "Çarpımın türevi", "Zincir kuralı"). Gerekirse onların da altında bir seviye
daha olabilir; toplam derinlik en fazla 3.`;

	const invariants = `Kurallar:
- SADECE <context> bloğundaki bilgiye dayan. Context dışında hiçbir bilgi kullanma.
- "label" kısa bir KAVRAM ADIDIR (1-4 kelime), tam cümle değil.
- "label" içine ASLA kaynak kimliği yazma. "Türev alma kuralları (S13)" YANLIŞ,
  "Türev alma kuralları" DOĞRU. Kimlik ayrı bir alan olan "source_id"ye yazılır.
- "label" ASLA bir dosya adı olamaz: "stewart-calculus-early-transcendentals.md" gibi bir etiket
  kesinlikle yasak. Kaynağın başlığını da olduğu gibi kopyalama.
- "summary" o kavramı bilmeyen birine açıklayan tek bir cümledir; etiketi tekrar etmez ve
  kaynaklardan/haritadan bahsetmez.
  KÖTÜ: "Zincir kuralı hakkında bilgi." İYİ: "Bileşke fonksiyonun türevini, dış ve iç
  fonksiyonların türevlerinin çarpımı olarak verir."
- Konuyu gerçekten dallara ayır; her şeyi tek bir dal altında toplama.
- "source_id" sadece verilen kimliklerden biri olabilir (S1, S2, ...). Asla dosya yolu yazma.`;

	return [taskIntro, userSkillsBlock, invariants, `<context>\n${contextBlock}\n</context>`, closingRules]
		.filter(Boolean)
		.join('\n\n');
}

export async function generateMindMap(
	v: VaultContext,
	input: GenerateMindMapInput,
	onProgress?: (stage: ProgressStage, elapsedMs?: number) => void
): Promise<{ mindmapId: string }> {
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

	// k=16, higher than the other generators use: select-chunks.ts already caps
	// each file at MAX_CHUNKS_PER_FILE (3), so a bigger k buys more DISTINCT
	// FILES rather than more chunks of the same one. That is exactly what the
	// "relate at least two sources" rule in parseAndValidate needs in order to
	// be satisfiable, and why maps used to collapse onto a single note.
	const retrieved = await retrieve(v, query, {
		domains: input.domains,
		includedPaths: input.includedPaths,
		k: 16
	});
	assertNoEmbeddingIssue(retrieved);
	const { chunks, narrowScope, reason } = retrieved;
	if (chunks.length === 0) {
		throw new NoSourcesError(narrowScope, reason);
	}

	// Short id per chunk (S1, S2, ...) instead of a path for the model to copy
	// — see mindmap-schema.ts's doc comment. heading_path stays visible in the
	// context because it is useful grounding, but the model never echoes it.
	const idToChunk = new Map<string, CitedChunk>(
		chunks.map((c, i) => [`S${i + 1}`, { path: c.path, heading_path: c.heading_path }])
	);
	const contextBlock = chunks
		.map(
			(c, i) =>
				`id: S${i + 1}\nsource_path: ${c.path}\nheading_path: ${c.heading_path}\ndepth: ${c.depth}\n\n${c.display_text}`
		)
		.join('\n\n---\n\n');
	const userSkillsBlock = await renderUserSkillsBlock('mindmap');
	// The vault decides the output language, exactly as chat does (see
	// prompt.ts coreIntro). The first element is the primary language.
	const allowed = getLibrarySettings(v).allowedLanguages;
	const language = (allowed.length ? allowed : DEFAULT_ALLOWED_LANGUAGES)[0];
	const systemPrompt = buildSystemPrompt(contextBlock, userSkillsBlock, language);
	const format = buildMindMapTreeJsonSchema([...idToChunk.keys()]);

	// One deadline for the whole generation, retries included.
	const deadline = AbortSignal.timeout(GENERATION_BUDGET_MS);

	onProgress?.('generating');
	let raw = await callModel(
		input.model,
		systemPrompt,
		input.prompt,
		format,
		input.provider,
		deadline,
		(ms) => onProgress?.('generating', ms)
	);

	onProgress?.('validating');
	let parsed = parseAndValidateMindMap(raw, idToChunk);
	let quality = parsed.ok ? assessMindMapQuality(parsed.result, idToChunk) : null;

	/**
	 * Retries on EITHER a hard failure or a quality hint, but only a hard
	 * failure can end the generation empty-handed.
	 *
	 * Three live runs died here when the quality rules were hard gates: each
	 * burned every attempt on a different rule and returned an error, so the
	 * user got nothing at all. A flawed map beats no map, and unlike a
	 * fabricated citation none of the quality issues makes the artifact
	 * dishonest. The retries still push toward a real concept map; they just
	 * cannot veto the result.
	 */
	const MAX_RETRIES = 2;
	for (let attempt = 0; (!parsed.ok || quality) && attempt < MAX_RETRIES; attempt++) {
		onProgress?.('retrying');
		const problem = parsed.ok ? quality! : parsed.error;
		const retryPrompt = `${input.prompt}\n\nÖnceki cevabın sorunluydu: ${problem}\nSADECE geçerli JSON döndür ve HER ŞEYİ ${language} yaz.`;
		// The budget can expire mid-retry. That is not a failure if an earlier
		// attempt already produced something storable — the retry was only ever
		// chasing better quality, so keep what we have rather than throwing it
		// away for running out of time.
		try {
			raw = await callModel(
				input.model,
				systemPrompt,
				retryPrompt,
				format,
				input.provider,
				deadline,
				(ms) => onProgress?.('retrying', ms)
			);
		} catch (err) {
			if (parsed.ok) break;
			throw err;
		}
		const next = parseAndValidateMindMap(raw, idToChunk);
		// Never trade a usable answer for an unusable one: if the retry came
		// back hard-invalid, keep what already parsed and stop asking.
		if (!next.ok && parsed.ok) break;
		parsed = next;
		quality = parsed.ok ? assessMindMapQuality(parsed.result, idToChunk) : null;
	}

	if (!parsed.ok) {
		throw new AppError(
			'GEN_MINDMAP_INVALID',
			parsed.reason ? { reason: parsed.reason, ...parsed.reasonParams } : { detail: parsed.error }
		);
	}

	const { rootLabel, rootSummary, nodes, droppedFileNameLabels } = parsed.result;

	// The user asked for a debug trail rather than a visible warning: dropping
	// is silent for them (the rule is that a source name must NEVER appear),
	// but a run that needed cleaning up should still be findable afterwards.
	if (droppedFileNameLabels.length > 0) {
		logAppEvent({
			kind: 'generation_warning',
			generationType: 'mindmap',
			model: input.model,
			message: `${droppedFileNameLabels.length} düğüm etiketi kaynak dosya adı olduğu için düşürüldü (ör. "${droppedFileNameLabels[0]}")`
		});
	}

	// Titled by its ROOT concept rather than the raw user prompt: the root is
	// now a real node carrying the topic and its definition, so "Türev" beats
	// "Basit ve kısa bir zihin haritası istiyorum" everywhere this title is
	// listed (study panel, recent items).
	const title =
		rootLabel || (input.prompt.length > 80 ? `${input.prompt.slice(0, 77)}...` : input.prompt);
	const mindmapId = createMindMap(
		v,
		title,
		{ domains: input.domains ?? null, chatId: input.chatId ?? null, prompt: input.prompt },
		input.model,
		nodes,
		rootSummary
	);
	return { mindmapId };
}
