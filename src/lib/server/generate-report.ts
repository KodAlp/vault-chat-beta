import { chatWithFallback } from './providers/registry';
import type { ChatMessage } from './providers/types';
import { retrieve } from './retrieve';
import { getMessages } from './chats-db';
import { ReportSections, buildReportSectionsJsonSchema } from './report-schema';
import { createReport, type NewReportSection } from './study-db';
import { renderUserSkillsBlock } from './userSkills';
import type { VaultContext } from './vaults';
import { NoSourcesError, assertNoEmbeddingIssue } from './generate-errors';
import { AppError } from './app-error';
import type { ReasonKey } from '../errors';

export interface GenerateReportInput {
	domains?: string[];
	chatId?: string;
	prompt: string;
	model: string;
	/** See ChatRequestBody.provider's doc comment (#lib/types.ts) — same
	 * optional pin, threaded into every chatWithFallback call below. */
	provider?: string;
	/** Chat's own source-tree scope selection — see ChatRequestBody.includedPaths. */
	includedPaths?: string[];
}

export type ProgressStage = 'retrieving' | 'generating' | 'validating' | 'retrying';

const QUERY_EXTRACT_SYSTEM_PROMPT =
	'Kullanıcının rapor isteğinden, sadece KONUYU özetleyen kısa bir arama sorgusu çıkar. "rapor hazırla", "özetle" gibi talimat kelimelerini ATLA, sadece konuyu yaz. Tek satır, sadece sorgu metni, başka hiçbir şey yazma.';

const QUERY_EXTRACT_BUDGET_MS = 60_000;

/** Same load-bearing determinism note as generate-quiz.ts's extractTopicalQuery. */
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
		'report',
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
			'report',
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

// `error` is Turkish because it goes back to the model in the retry prompt;
// `reason` is what the user sees, localized client-side.
type ParseResult =
	| { ok: true; sections: NewReportSection[] }
	| { ok: false; error: string; reason?: ReasonKey; reasonParams?: Record<string, number> };

/**
 * Report's anti-hallucination check is looser than quiz/cards' "must equal
 * one retrieved path" — a section synthesizes across multiple chunks, so
 * source_ids is a SUBSET check (against the S1/S2/... ids assigned in
 * buildSystemPrompt's context block, not raw paths — see report-schema.ts's
 * doc comment for why). But a subset-valid, schema-valid response can still
 * be useless: a model hedging by citing every retrieved source in every
 * section. Reject that degenerate case explicitly — quiz/cards never had to
 * guard against it since they only ever have one path per item. Threshold
 * is `> 2` sources, not `> 1`: a genuinely synthesized 2-source report
 * legitimately cites both in most sections, and was being rejected
 * unfairly before this.
 */
function parseAndValidate(raw: string, idToPath: Map<string, string>): ParseResult {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, error: 'Model geçerli JSON döndürmedi.', reason: 'invalid_json' };
	}
	const result = ReportSections.safeParse(json);
	if (!result.success) {
		return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
	}
	const badSections = result.data.sections.filter((s) =>
		s.source_ids.some((id) => !idToPath.has(id))
	);
	if (badSections.length > 0) {
		return {
			ok: false,
			error: `${badSections.length} bölümün source_ids'i sağlanan kaynak kimlikleriyle eşleşmiyor (uydurma kaynak). Sadece S1, S2, ... gibi verilen kimlikleri kullan.`,
			reason: 'invented_source_ids',
			reasonParams: { count: badSections.length }
		};
	}
	// Compared over DISTINCT PATHS, not raw id counts: retrieve returns up to
	// 3 chunks per file (select-chunks.ts MAX_CHUNKS_PER_FILE), so 12 ids can
	// be only 4 real sources — counting ids made this check nearly unfireable.
	const distinctPaths = new Set(idToPath.values());
	if (
		distinctPaths.size > 2 &&
		result.data.sections.every(
			(s) => new Set(s.source_ids.map((id) => idToPath.get(id)!)).size === distinctPaths.size
		)
	) {
		return {
			ok: false,
			error: 'Her bölüm TÜM kaynakları aynı anda gösteriyor — her bölüm sadece ilgili olduğu kaynakları listelemeli, tüm kaynakları değil.',
			reason: 'report_sources_not_specific'
		};
	}
	if (result.data.sections.length === 0) {
		return { ok: false, error: 'Model hiç bölüm üretmedi.', reason: 'report_no_sections' };
	}
	// Deduped, not a plain map: two distinct ids legitimately resolve to the
	// SAME path (again, up to 3 chunks per file). The duplicate used to reach
	// the view route's `{#each r.section.source_paths as path (path)}`, whose
	// key is the path itself, and crashed the render with Svelte's
	// each_key_duplicate — thrown AFTER phase='ready' was assigned, which is
	// why the report page froze on "Yükleniyor" instead of showing an error.
	const sections: NewReportSection[] = result.data.sections.map((s) => ({
		heading: s.heading,
		body_markdown: s.body_markdown,
		source_paths: [...new Set(s.source_ids.map((id) => idToPath.get(id)!))]
	}));
	return { ok: true, sections };
}

export function buildSystemPrompt(contextBlock: string, userSkillsBlock: string): string {
	const taskIntro = `Sen bir rapor yazma asistanısın. Aşağıdaki <context> bloğu, her biri kısa bir kimlikle
(id: S1, S2, ...) ve source_path/heading_path/depth etiketleriyle işaretlenmiş kaynak parçalarından
oluşuyor. Bu kaynaklara dayanarak, konuyu 1-8 bölüm halinde ele alan uzun soluklu bir rapor yaz. Her
bölüm bir heading (başlık), o başlık altındaki düzyazı gövde metni (body_markdown) ve o bölümde
gerçekten kullandığın kaynak parçaların id'lerinin listesi (source_ids, örn. ["S1","S3"]) içermeli.
Bir bölüm birden fazla kaynak parçasını sentezleyebilir, ama SADECE o bölümde gerçekten atıfta
bulunduğun parçaların id'sini source_ids'e ekle — context'teki her parçayı her bölüme ekleme.`;

	const invariants = `Kurallar:
- SADECE <context> bloğundaki bilgiye dayanarak yaz. Context dışında hiçbir bilgi kullanma.
- Türkçe yaz. Matematik sadece $...$ (satır içi) veya $$...$$ (blok) içinde, asla çıplak LaTeX.
- source_ids listesindeki her değer SADECE "S" harfi + sayı formatında olmalı (S1, S2, ...) — asla
  dosya yolu, başlık veya başka bir metin yazma, sadece id.
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

	// keywordQuery: only the topic, not topic + summary — the keyword fallback (FTS-only mode, or an embedding
	// issue) ANDs every term, so the long summary tail would make it match nothing. See retrieve.ts.
	const retrieved = await retrieve(v, query, {
		keywordQuery: topicalQuery,
		domains: input.domains,
		includedPaths: input.includedPaths,
		k: 12
	});
	assertNoEmbeddingIssue(retrieved);
	const { chunks, narrowScope, reason } = retrieved;
	if (chunks.length === 0) {
		throw new NoSourcesError(narrowScope, reason);
	}

	// Short id per chunk (S1, S2, ...), not the raw path — see
	// report-schema.ts's doc comment on why the model cites these instead
	// of copying full paths verbatim.
	const idToPath = new Map(chunks.map((c, i) => [`S${i + 1}`, c.path]));
	const contextBlock = chunks
		.map(
			(c, i) =>
				`id: S${i + 1}\nsource_path: ${c.path}\nheading_path: ${c.heading_path}\ndepth: ${c.depth}\n\n${c.display_text}`
		)
		.join('\n\n---\n\n');
	const userSkillsBlock = await renderUserSkillsBlock('report');
	const systemPrompt = buildSystemPrompt(contextBlock, userSkillsBlock);
	const format = buildReportSectionsJsonSchema([...idToPath.keys()]);

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
		throw new AppError(
			'GEN_REPORT_INVALID',
			parsed.reason ? { reason: parsed.reason, ...parsed.reasonParams } : { detail: parsed.error }
		);
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
