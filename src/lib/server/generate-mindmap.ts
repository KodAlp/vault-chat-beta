import { chatWithFallback } from './providers/registry';
import type { ChatMessage } from './providers/types';
import { retrieve } from './retrieve';
import { getMessages } from './chats-db';
import { MindMapNodes, MINDMAP_NODES_JSON_SCHEMA } from './mindmap-schema';
import { createMindMap, type NewMindMapNode } from './study-db';
import { renderUserSkillsBlock } from './userSkills';

export interface GenerateMindMapInput {
	domains?: string[];
	chatId?: string;
	prompt: string;
	model: string;
}

export type ProgressStage = 'retrieving' | 'generating' | 'validating' | 'retrying';

const QUERY_EXTRACT_SYSTEM_PROMPT =
	'Kullanıcının zihin haritası isteğinden, sadece KONUYU özetleyen kısa bir arama sorgusu çıkar. "zihin haritası çıkar", "haritala" gibi talimat kelimelerini ATLA, sadece konuyu yaz. Tek satır, sadece sorgu metni, başka hiçbir şey yazma.';

async function extractTopicalQuery(prompt: string, model: string): Promise<string> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: QUERY_EXTRACT_SYSTEM_PROMPT },
		{ role: 'user', content: prompt }
	];
	let text = '';
	const signal = new AbortController().signal;
	for await (const event of chatWithFallback('mindmap', { model, messages, think: false, temperature: 0 }, signal)) {
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
		'mindmap',
		{ model, messages, think: false, format: MINDMAP_NODES_JSON_SCHEMA, temperature: 0.3 },
		signal
	)) {
		if (event.type === 'text') text += event.text;
	}
	return text;
}

type ParseResult = { ok: true; nodes: NewMindMapNode[] } | { ok: false; error: string };

function parseAndValidate(raw: string, validPaths: Set<string>): ParseResult {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, error: 'Model geçerli JSON döndürmedi.' };
	}
	const result = MindMapNodes.safeParse(json);
	if (!result.success) {
		return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
	}
	const badNodes = result.data.nodes.filter((n) => !validPaths.has(n.source_path));
	if (badNodes.length > 0) {
		return {
			ok: false,
			error: `${badNodes.length} düğümün source_path'i sağlanan kaynaklarla eşleşmiyor (uydurma kaynak).`
		};
	}
	if (result.data.nodes.length === 0) {
		return { ok: false, error: 'Model hiç düğüm üretmedi.' };
	}
	return { ok: true, nodes: result.data.nodes };
}

export function buildSystemPrompt(contextBlock: string, userSkillsBlock: string): string {
	const taskIntro = `Sen bir zihin haritası (mind map) çıkarma asistanısın. Aşağıdaki <context> bloğu, her biri
source_path/heading_path/depth etiketleriyle işaretlenmiş kaynak parçalarından oluşuyor. Bu konuyu
1-40 düğümlük düz bir liste olarak hiyerarşik biçimde çıkar. Her düğüm bir "path" (kök'ten o düğüme
kadar olan başlık zinciri, örn. ["SvelteKit", "Routing", "Dinamik rotalar"]), ve o düğümün dayandığı
kaynak parçanın source_path/heading_path etiketleri içermeli. Aynı üst dalı paylaşan düğümler path
dizisinin başlangıcını paylaşmalı (örn. ["SvelteKit","Routing","Dinamik rotalar"] ve
["SvelteKit","Routing","Form action'lar"]) — bu şekilde ağaç yapısı path'lerden otomatik kurulur,
sen sadece düz bir liste üretiyorsun.`;

	const invariants = `Kurallar:
- SADECE <context> bloğundaki bilgiye dayanarak düğümler üret. Context dışında hiçbir bilgi kullanma.
- Türkçe yaz. path içindeki her etiket kısa olmalı (birkaç kelime), tam cümle değil.
- Her düğümün source_path değeri, o düğümü hangi kaynak parçasından ürettiysen SADECE o parçanın
  KENDİ source_path etiketinin değeriyle BİREBİR AYNI olmalı.
- heading_path değeri de aynı şekilde ilgili parçanın KENDİ heading_path etiketinin değeriyle
  birebir aynı olmalı.
- path dizisi en fazla 4 seviye derinliğinde olmalı — çok derin dallanmadan kaçın.`;

	return [taskIntro, userSkillsBlock, invariants, `<context>\n${contextBlock}\n</context>`]
		.filter(Boolean)
		.join('\n\n');
}

export async function generateMindMap(
	input: GenerateMindMapInput,
	onProgress?: (stage: ProgressStage) => void
): Promise<{ mindmapId: string }> {
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
	const contextBlock = chunks
		.map(
			(c) =>
				`source_path: ${c.path}\nheading_path: ${c.heading_path}\ndepth: ${c.depth}\n\n${c.display_text}`
		)
		.join('\n\n---\n\n');
	const userSkillsBlock = await renderUserSkillsBlock('mindmap');
	const systemPrompt = buildSystemPrompt(contextBlock, userSkillsBlock);

	onProgress?.('generating');
	let raw = await callModel(input.model, systemPrompt, input.prompt);

	onProgress?.('validating');
	let parsed = parseAndValidate(raw, validPaths);

	const MAX_RETRIES = 2;
	for (let attempt = 0; !parsed.ok && attempt < MAX_RETRIES; attempt++) {
		onProgress?.('retrying');
		const retryPrompt = `${input.prompt}\n\nÖnceki cevabın geçersizdi: ${parsed.error}\nSADECE geçerli JSON döndür. source_path, kullandığın kaynak parçasının EN ÜSTÜNDEKİ source_path etiketiyle birebir aynı olmalı.`;
		raw = await callModel(input.model, systemPrompt, retryPrompt);
		parsed = parseAndValidate(raw, validPaths);
	}

	if (!parsed.ok) {
		throw new Error(`Zihin haritası üretilemedi: ${parsed.error}`);
	}

	const title = input.prompt.length > 80 ? `${input.prompt.slice(0, 77)}...` : input.prompt;
	const mindmapId = createMindMap(
		title,
		{ domains: input.domains ?? null, chatId: input.chatId ?? null, prompt: input.prompt },
		input.model,
		parsed.nodes
	);
	return { mindmapId };
}
