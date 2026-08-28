import { chatWithFallback } from './providers/registry';
import type { ChatMessage } from './providers/types';
import { retrieve } from './retrieve';
import { getMessages } from './chats-db';
import { ReportSections, REPORT_SECTIONS_JSON_SCHEMA } from './report-schema';
import { createReport, type NewReportSection } from './study-db';
import { renderUserSkillsBlock } from './userSkills';
import type { VaultContext } from './vaults';
import { NoSourcesError } from './generate-errors';

export interface GenerateReportInput {
	domains?: string[];
	chatId?: string;
	prompt: string;
	model: string;
	/** Chat's own source-tree scope selection — see ChatRequestBody.includedPaths. */
	includedPaths?: string[];
}

export type ProgressStage = 'retrieving' | 'generating' | 'validating' | 'retrying';

const QUERY_EXTRACT_SYSTEM_PROMPT =
	'Kullanıcının rapor isteğinden, sadece KONUYU özetleyen kısa bir arama sorgusu çıkar. "rapor hazırla", "özetle" gibi talimat kelimelerini ATLA, sadece konuyu yaz. Tek satır, sadece sorgu metni, başka hiçbir şey yazma.';

/** Same load-bearing determinism note as generate-quiz.ts's extractTopicalQuery. */
async function extractTopicalQuery(prompt: string, model: string): Promise<string> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: QUERY_EXTRACT_SYSTEM_PROMPT },
		{ role: 'user', content: prompt }
	];
	let text = '';
	const signal = new AbortController().signal;
	for await (const event of chatWithFallback('report', { model, messages, think: false, temperature: 0 }, signal)) {
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
			'report',
			{ model, messages, think: false, format: REPORT_SECTIONS_JSON_SCHEMA, temperature: 0.3 },
			signal
		)) {
			if (event.type === 'text') text += event.text;
		}
	} finally {
		if (timer) clearInterval(timer);
	}
	return text;
}

type ParseResult = { ok: true; sections: NewReportSection[] } | { ok: false; error: string };

/**
 * Report's anti-hallucination check is looser than quiz/cards' "must equal
 * one retrieved path" — a section synthesizes across multiple chunks, so
 * source_paths is a SUBSET check. But a subset-valid, schema-valid response
 * can still be useless: a model hedging by citing every retrieved path in
 * every section. Reject that degenerate case explicitly — quiz/cards never
 * had to guard against it since they only ever have one path per item.
 */
function parseAndValidate(raw: string, validPaths: Set<string>): ParseResult {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, error: 'Model geçerli JSON döndürmedi.' };
	}
	const result = ReportSections.safeParse(json);
	if (!result.success) {
		return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
	}
	const badSections = result.data.sections.filter((s) =>
		s.source_paths.some((p) => !validPaths.has(p))
	);
	if (badSections.length > 0) {
		return {
			ok: false,
			error: `${badSections.length} bölümün source_paths'i sağlanan kaynaklarla eşleşmiyor (uydurma kaynak).`
		};
	}
	if (
		validPaths.size > 1 &&
		result.data.sections.every((s) => s.source_paths.length === validPaths.size)
	) {
		return {
			ok: false,
			error: 'Her bölüm TÜM kaynakları aynı anda gösteriyor — her bölüm sadece ilgili olduğu kaynakları listelemeli, tüm kaynakları değil.'
		};
	}
	if (result.data.sections.length === 0) {
		return { ok: false, error: 'Model hiç bölüm üretmedi.' };
	}
	return { ok: true, sections: result.data.sections };
}

export function buildSystemPrompt(contextBlock: string, userSkillsBlock: string): string {
	const taskIntro = `Sen bir rapor yazma asistanısın. Aşağıdaki <context> bloğu, her biri source_path/heading_path/depth
etiketleriyle işaretlenmiş kaynak parçalarından oluşuyor. Bu kaynaklara dayanarak, konuyu 1-8 bölüm
halinde ele alan uzun soluklu bir rapor yaz. Her bölüm bir heading (başlık), o başlık altındaki
düzyazı gövde metni (body_markdown) ve o bölümde gerçekten kullandığın kaynak parçaların
source_path'lerinin listesi (source_paths) içermeli. Bir bölüm birden fazla kaynak parçasını
sentezleyebilir, ama SADECE o bölümde gerçekten atıfta bulunduğun parçaları source_paths'e ekle —
context'teki her parçayı her bölüme ekleme.`;

	const invariants = `Kurallar:
- SADECE <context> bloğundaki bilgiye dayanarak yaz. Context dışında hiçbir bilgi kullanma.
- Türkçe yaz. Matematik sadece $...$ (satır içi) veya $$...$$ (blok) içinde, asla çıplak LaTeX.
- Her bölümün source_paths listesindeki her değer, o bölümde gerçekten kullandığın kaynak
  parçalarının KENDİ source_path etiketinin değeriyle BİREBİR AYNI olmalı — parçaların metin
  içeriğinde geçen başka dosya adları/[[bağlantılar]] değil.
- body_markdown akıcı düzyazı olmalı, madde madde kopyalanmış context parçaları değil — sentezle,
  kendi cümlelerinle açıkla.`;

	return [taskIntro, userSkillsBlock, invariants, `<context>\n${contextBlock}\n</context>`]
		.filter(Boolean)
		.join('\n\n');
}

export async function generateReport(
	v: VaultContext,
	input: GenerateReportInput,
	onProgress?: (stage: ProgressStage, elapsedMs?: number) => void
): Promise<{ reportId: string }> {
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

	const { chunks, narrowScope } = await retrieve(v, query, {
		domains: input.domains,
		includedPaths: input.includedPaths,
		k: 12
	});
	if (chunks.length === 0) {
		throw new NoSourcesError(narrowScope);
	}

	const validPaths = new Set(chunks.map((c) => c.path));
	const contextBlock = chunks
		.map(
			(c) =>
				`source_path: ${c.path}\nheading_path: ${c.heading_path}\ndepth: ${c.depth}\n\n${c.display_text}`
		)
		.join('\n\n---\n\n');
	const userSkillsBlock = await renderUserSkillsBlock('report');
	const systemPrompt = buildSystemPrompt(contextBlock, userSkillsBlock);

	onProgress?.('generating');
	let raw = await callModel(input.model, systemPrompt, input.prompt, (ms) => onProgress?.('generating', ms));

	onProgress?.('validating');
	let parsed = parseAndValidate(raw, validPaths);

	const MAX_RETRIES = 2;
	for (let attempt = 0; !parsed.ok && attempt < MAX_RETRIES; attempt++) {
		onProgress?.('retrying');
		const retryPrompt = `${input.prompt}\n\nÖnceki cevabın geçersizdi: ${parsed.error}\nSADECE geçerli JSON döndür.`;
		raw = await callModel(input.model, systemPrompt, retryPrompt, (ms) => onProgress?.('retrying', ms));
		parsed = parseAndValidate(raw, validPaths);
	}

	if (!parsed.ok) {
		throw new Error(`Rapor üretilemedi: ${parsed.error}`);
	}

	const title = input.prompt.length > 80 ? `${input.prompt.slice(0, 77)}...` : input.prompt;
	const reportId = createReport(
		v,
		title,
		{ domains: input.domains ?? null, chatId: input.chatId ?? null, prompt: input.prompt },
		input.model,
		parsed.sections
	);
	return { reportId };
}
