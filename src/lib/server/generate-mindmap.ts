import { chatWithFallback } from './providers/registry';
import type { ChatMessage } from './providers/types';
import { retrieve } from './retrieve';
import { getMessages } from './chats-db';
import { buildMindMapNodesJsonSchema } from './mindmap-schema';
import { parseAndValidateMindMap, type CitedChunk } from './mindmap-validate';
import { createMindMap } from './study-db';
import { renderUserSkillsBlock } from './userSkills';
import type { VaultContext } from './vaults';
import { NoSourcesError } from './generate-errors';

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

const QUERY_EXTRACT_SYSTEM_PROMPT =
	'Kullanıcının zihin haritası isteğinden, sadece KONUYU özetleyen kısa bir arama sorgusu çıkar. "zihin haritası çıkar", "haritala" gibi talimat kelimelerini ATLA, sadece konuyu yaz. Tek satır, sadece sorgu metni, başka hiçbir şey yazma.';

async function extractTopicalQuery(prompt: string, model: string, provider?: string): Promise<string> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: QUERY_EXTRACT_SYSTEM_PROMPT },
		{ role: 'user', content: prompt }
	];
	let text = '';
	const signal = new AbortController().signal;
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

export function buildSystemPrompt(contextBlock: string, userSkillsBlock: string): string {
	const taskIntro = `Sen bir KAVRAM HARİTASI çıkarma asistanısın. Aşağıdaki <context> bloğu, her biri kısa bir
kimlikle (id: S1, S2, ...) ve source_path/heading_path/depth etiketleriyle işaretlenmiş kaynak
parçalarından oluşuyor. Bu kaynaklardaki BİLGİYİ 1-40 düğümlük düz bir liste olarak hiyerarşik
biçimde çıkar. Her düğüm bir "path" (kök'ten o düğüme kadar olan etiket zinciri, örn.
["Zamanlama politikaları", "Adalet", "Orantılı pay"]) ve o düğümü hangi parçadan ürettiysen o
parçanın "source_id" değerini içermeli. Aynı üst dalı paylaşan düğümler path dizisinin başlangıcını
paylaşmalı — ağaç yapısı path'lerden otomatik kurulur, sen sadece düz bir liste üretiyorsun.`;

	const invariants = `Kurallar:
- SADECE <context> bloğundaki bilgiye dayanarak düğümler üret. Context dışında hiçbir bilgi kullanma.
- EN ÖNEMLİ KURAL: bir düğüm etiketi KOPYALANAMAZ. Ne kaynağın heading_path'inden, ne de
  source_path'inden/dosya adından. Etiket, senin kendi cümlenle yazdığın bir KAVRAM, MEKANİZMA
  veya İDDİA olmalı.
  GEÇERSİZ: "Key claims", "Bölüm 4" (başlık kopyası) — "corbett-et-al-2012-spanner.md",
  "sveltekit-architecture-and-internals" (dosya adı kopyası).
  GEÇERLİ: "Bilet sayısıyla orantılı CPU payı", "Saat belirsizliğini bekleyerek tutarlılık".
- Harita DÜZ BİR LİSTE olamaz; hiyerarşi haritanın kendisidir. Önce 2-5 üst kavram dalı belirle,
  sonra her dalın altına o dala ait alt kavramları yerleştir — yani düğümlerin çoğunun path
  dizisi en az 2 seviyeli olmalı. Örnek: {"path": ["Tutarlılık garantileri", "Doğrusallaştırma"],
  "source_id": "S3"}.
- Verilen kaynakların mümkün olduğunca ÇOĞUNU kullan ve aralarındaki ilişkiyi göster. Tek bir
  kaynaktan çıkarılmış harita geçersizdir — kavramları farklı kaynaklar arasında ilişkilendir.
- Türkçe yaz. Her etiket kısa olmalı (birkaç kelime), tam cümle değil.
- source_id AYRI BİR ALAN. "path" dizisinin içine ASLA S1/S2 gibi bir kimlik yazma; path sadece
  insan tarafından okunacak kavram etiketlerinden oluşur. Örnek doğru düğüm:
  {"path": ["Zamanlama politikaları", "Orantılı pay"], "source_id": "S3"}.
- source_id, o düğümü ürettiğin parçanın id'si olmalı — sadece S1, S2, ... gibi verilen kimlikleri
  kullan, asla dosya yolu yazma.
- path dizisi en fazla 4 seviye derinliğinde olmalı — çok derin dallanmadan kaçın.`;

	return [taskIntro, userSkillsBlock, invariants, `<context>\n${contextBlock}\n</context>`]
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
	const { chunks, narrowScope } = await retrieve(v, query, {
		domains: input.domains,
		includedPaths: input.includedPaths,
		k: 16
	});
	if (chunks.length === 0) {
		throw new NoSourcesError(narrowScope);
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
	const systemPrompt = buildSystemPrompt(contextBlock, userSkillsBlock);
	const format = buildMindMapNodesJsonSchema([...idToChunk.keys()]);

	onProgress?.('generating');
	let raw = await callModel(input.model, systemPrompt, input.prompt, format, input.provider, (ms) =>
		onProgress?.('generating', ms)
	);

	onProgress?.('validating');
	let parsed = parseAndValidateMindMap(raw, idToChunk);

	const MAX_RETRIES = 2;
	for (let attempt = 0; !parsed.ok && attempt < MAX_RETRIES; attempt++) {
		onProgress?.('retrying');
		const retryPrompt = `${input.prompt}\n\nÖnceki cevabın geçersizdi: ${parsed.error}\nSADECE geçerli JSON döndür.`;
		raw = await callModel(input.model, systemPrompt, retryPrompt, format, input.provider, (ms) =>
			onProgress?.('retrying', ms)
		);
		parsed = parseAndValidateMindMap(raw, idToChunk);
	}

	if (!parsed.ok) {
		throw new Error(`Zihin haritası üretilemedi: ${parsed.error}`);
	}

	const title = input.prompt.length > 80 ? `${input.prompt.slice(0, 77)}...` : input.prompt;
	const mindmapId = createMindMap(
		v,
		title,
		{ domains: input.domains ?? null, chatId: input.chatId ?? null, prompt: input.prompt },
		input.model,
		parsed.nodes
	);
	return { mindmapId };
}
