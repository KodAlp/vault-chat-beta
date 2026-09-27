/**
 * Generation benchmark CLI — runs the golden set through the real chat
 * pipeline (bench/lib/sut.ts: retrieve() -> buildPromptMessages() -> a
 * direct streamed Ollama /api/chat call) and, unless --no-judge, scores every
 * answer with an LLM judge (bench/lib/judge.ts) built from the DeepSeek
 * OpenAI-compatible adapter — gated hard behind `--allow-cloud deepseek-api`,
 * refused before any network call otherwise.
 *
 *   npx tsx bench/run-generation.ts --vault default --file <golden.jsonl>
 *     [--label x] [--limit N] [--model qwen3:8b] [--answers <answers.jsonl>]
 *     [--judge-model deepseek-v4-pro] [--allow-cloud deepseek-api] [--no-judge]
 *     [--rejudge N] [--sanity]
 *
 * Writes data/vaults/default/bench/results/<ISO>-<label>/{answers.jsonl,
 * generation.json, generation.md, pooled-qrels.jsonl}. Opens index.db
 * read-only (via retrieve.ts's own connection) and never writes to any app
 * data file other than its own results/cache directories under
 * data/vaults/default/bench/ — chats.db/index.db/study.db are snapshotted
 * before and after, like run-retrieval.ts.
 *
 * ABSOLUTE RULE: zero calls to DeepSeek/any cloud provider without
 * --allow-cloud deepseek-api. --no-judge runs fully local (SUT + perf only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveVault } from '../src/lib/server/vaults';
import { dataDir } from '../src/lib/server/env';
import { getLibrarySettings } from '../src/lib/server/library';
import { stripForDetection, countLetters } from '../src/lib/server/response-language';
import { francAll } from 'franc-min';
import { OpenAICompatAdapter } from '../src/lib/server/providers/openai-compat';
import { secretStore, maskKey } from '../src/lib/server/providers/secrets';
import { providersPath } from '../src/lib/server/env';
import { parseGoldenLine, checkAnswerabilityRules, type GoldenLine } from './dataset/golden';
import { chunkAnchor } from './lib/anchor';
import { defaultSutContext, runSut, setupIsolation, type SutContext, type SutResult } from './lib/sut';
import {
	buildJudgePrompt,
	callJudge,
	judgePromptSha1,
	type JudgeAdapter,
	type JudgeCallResult,
	type JudgeItemInput,
	type JudgeResult
} from './lib/judge';
import {
	computeAbstention,
	computeCitation,
	computeContextRelevance,
	computeCorrectness,
	computeHallucination,
	computePerformance,
	computeRelevance,
	computeResponseLanguageCompliance,
	computeSanityCheck,
	computeSelfConsistency,
	computeSmalltalkCompliance,
	computeTypeAccuracy,
	judgedGrade2Chunks,
	type GenItem,
	type TimingRecord
} from './lib/gen-metrics';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i !== -1 ? argv[i + 1] : undefined;
}
function hasFlag(flag: string): boolean {
	return argv.includes(flag);
}

const vaultId = argValue('--vault') ?? 'default';
const file = argValue('--file');
const label = argValue('--label') ?? 'run';
const limitArg = argValue('--limit');
const limit = limitArg ? Number(limitArg) : undefined;
const model = argValue('--model') ?? 'qwen3:8b';
const answersInputPath = argValue('--answers');
const judgeModel = argValue('--judge-model') ?? 'deepseek-v4-pro';
const allowCloud = argValue('--allow-cloud'); // expected: 'deepseek-api'
const noJudge = hasFlag('--no-judge');
const rejudgeArg = argValue('--rejudge');
const rejudgeN = rejudgeArg ? Number(rejudgeArg) : 0;
const doSanity = hasFlag('--sanity');

if (!file && !answersInputPath) {
	console.error('en az bir --file <golden.jsonl> ya da --answers <answers.jsonl> gerekli');
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Cloud gate — refused before ANY network call, including provider/secret
// construction, if judging (or --sanity, which also judges) was requested.
// ---------------------------------------------------------------------------

const needsJudge = !noJudge;
if (needsJudge && allowCloud !== 'deepseek-api') {
	console.error(
		'REDDEDILDI: yargıç (judge) DeepSeek bulut API\'sine istek atacaktı ama --allow-cloud deepseek-api verilmedi.\n' +
			'Kasa içeriğinin buluta gitmesi kullanıcı onayı gerektirir (ABSOLUTE RULE). ' +
			'Yalnızca yerel çalıştırmak için --no-judge kullanın, ya da onayladıysanız --allow-cloud deepseek-api ekleyin.'
	);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Isolation snapshot
// ---------------------------------------------------------------------------

interface FileSnapshot {
	path: string;
	exists: boolean;
	size?: number;
	mtimeMs?: number;
}
function snapshot(p: string): FileSnapshot {
	try {
		const st = fs.statSync(p);
		return { path: p, exists: true, size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		return { path: p, exists: false };
	}
}

setupIsolation();

const vault = resolveVault(vaultId);
const watchedPaths = [path.join(dataDir(), 'chats.db'), vault.indexDbPath, vault.studyDbPath];
const before = watchedPaths.map(snapshot);
console.log('[isolation] önce:', JSON.stringify(before));

// ---------------------------------------------------------------------------
// Golden set
// ---------------------------------------------------------------------------

let items: GoldenLine[] = [];
let datasetSha1 = '';
if (file) {
	if (!fs.existsSync(file)) {
		console.error(`dosya yok: ${file}`);
		process.exit(1);
	}
	const raw = fs.readFileSync(file, 'utf-8');
	datasetSha1 = createHash('sha1').update(raw).digest('hex');
	const rawLines = raw.split('\n').filter((l) => l.trim().length > 0);
	let errors = 0;
	for (let i = 0; i < rawLines.length; i++) {
		const { line, errors: lineErrors } = parseGoldenLine(rawLines[i], i + 1);
		if (lineErrors.length > 0) {
			errors += lineErrors.length;
			for (const e of lineErrors) console.error(e);
			continue;
		}
		const ruleErrors = checkAnswerabilityRules(line!);
		if (ruleErrors.length > 0) {
			errors += ruleErrors.length;
			for (const e of ruleErrors) console.error(e);
			continue;
		}
		items.push(line!);
	}
	if (errors > 0) {
		console.error(`${errors} şema/kural hatası — çalıştırma durduruldu.`);
		process.exit(1);
	}
	if (limit !== undefined) items = items.slice(0, limit);
}
console.log(`[golden] ${items.length} soru yüklendi${file ? ` (${file})` : ' (sadece --answers)'}`);

// ---------------------------------------------------------------------------
// Output dir
// ---------------------------------------------------------------------------

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(dataDir(), 'vaults', 'default', 'bench', 'results', `${timestamp}-${label}`);
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// SUT phase — run, or load cached answers
// ---------------------------------------------------------------------------

interface AnswerRecord {
	id: string;
	type: string;
	lang: string;
	answerable: boolean;
	question: string;
	turns?: { role: 'user' | 'assistant'; content: string }[];
	reference_answer: string;
	sut: SutResult;
}

const deviations = [
	'smallTalkGate atlandı: gerçek gate chats.db üzerinde ilk çağrıda seed yazabiliyor (smalltalk-runtime.ts), izolasyon kuralı bunu engelledi.',
	'Ollama isteği doğrudan /api/chat\'e gidiyor (providers/registry.ts, chatWithFallback, resume/corruption retry, tool round-trip\'leri, fallback zinciri devre dışı).',
	'options.num_ctx sabit 8192 (providers/ollama.ts\'in serveCtxFor() tablosu private olduğu için birebir çağrılamadı; qwen3 ailesi için ölçülen değerle aynı).',
	'CHAT_MAX_OUTPUT_TOKENS / num_predict ayarlanmadı — gerçek rotanın 4096 tokenlık tavanı burada uygulanmıyor.',
	'chats.db\'ye hiçbir mesaj yazılmıyor (checkpoint/insertMessage yok) — bu kasıtlı, izolasyon gereği.',
	'Kaynak kaynağı kaydı (assistant mesajının sourcesJson\'ı) üretilmiyor; kaynaklar yalnızca bench çıktısında (SutResult.chunks) tutuluyor.'
];

let answers: AnswerRecord[] = [];

if (answersInputPath) {
	if (!fs.existsSync(answersInputPath)) {
		console.error(`--answers dosyası yok: ${answersInputPath}`);
		process.exit(1);
	}
	const raw = fs.readFileSync(answersInputPath, 'utf-8');
	answers = raw
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as AnswerRecord);
	if (limit !== undefined) answers = answers.slice(0, limit);
	console.log(`[answers] ${answers.length} önceden üretilmiş cevap yüklendi (${answersInputPath})`);
} else {
	const librarySettings = getLibrarySettings(vault);
	const sutCtx: SutContext = defaultSutContext(vault, model, {
		allowedLanguages: librarySettings.allowedLanguages,
		responseLanguage: librarySettings.responseLanguage
	});
	let done = 0;
	for (const item of items) {
		const sut = await runSut(sutCtx, { question: item.question, turns: item.turns });
		answers.push({
			id: item.id,
			type: item.type,
			lang: item.lang,
			answerable: item.answerable,
			question: item.question,
			turns: item.turns,
			reference_answer: item.reference_answer,
			sut
		});
		done++;
		console.log(`[sut] ${done}/${items.length} id=${item.id} ttft=${sut.timings.ttftMs ?? '—'}ms total=${sut.timings.totalMs}ms`);
	}
	const answersPath = path.join(outDir, 'answers.jsonl');
	fs.writeFileSync(answersPath, answers.map((a) => JSON.stringify(a)).join('\n') + '\n', 'utf-8');
	console.log(`[answers] yazıldı: ${answersPath}`);
}

// If we loaded from --answers, still copy them into this run's own directory
// so generation.json's directory is self-contained, like a fresh run would be.
if (answersInputPath) {
	const answersPath = path.join(outDir, 'answers.jsonl');
	fs.writeFileSync(answersPath, answers.map((a) => JSON.stringify(a)).join('\n') + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Judge adapter construction (only reached if needsJudge — the gate above
// already refused otherwise)
// ---------------------------------------------------------------------------

interface UsageTotals {
	promptTokens: number;
	completionTokens: number;
	calls: number;
}
const usageTotals: UsageTotals = { promptTokens: 0, completionTokens: 0, calls: 0 };

// ---------------------------------------------------------------------------
// Spend cap. DeepSeek list prices (api-docs.deepseek.com/quick_start/pricing, read 2026-09-27),
// USD per 1M tokens; off-peak is half of peak. Reasoning tokens are counted as output (the docs
// don't say they're billed separately — assume the expensive case). When the stream carries no
// usage event, tokens are estimated from characters at 3 chars/token (conservative for TR/EN).
// ---------------------------------------------------------------------------
const PRICES_PEAK: Record<string, { input: number; output: number }> = {
	'deepseek-v4-pro': { input: 1.32, output: 3.96 },
	'deepseek-flash': { input: 0.3, output: 1.2 }
};
/** Mon-Fri 01:00-04:00 and 06:00-10:00 UTC. */
function isPeak(at: Date): boolean {
	const day = at.getUTCDay();
	if (day === 0 || day === 6) return false;
	const h = at.getUTCHours();
	return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
function callCostUsd(promptTokens: number, completionTokens: number, at: Date): number {
	const peak = PRICES_PEAK[judgeModel] ?? PRICES_PEAK['deepseek-v4-pro'];
	const f = isPeak(at) ? 1 : 0.5;
	return ((promptTokens * peak.input + completionTokens * peak.output) / 1e6) * f;
}
const maxCostUsd = Number(argValue('--max-cost-usd') ?? '2.10');
let spentUsd = 0;
let lastCallUsd = 0;
let usageEstimated = false;
let budgetStop = false;
/** True when the next call (sized like the last one, or 0.03 USD before any call) would pass the cap. */
function overBudget(): boolean {
	if (budgetStop) return true;
	const next = lastCallUsd || 0.03;
	if (spentUsd + next > maxCostUsd) {
		budgetStop = true;
		console.log(`[budget] DURDURULDU: harcanan ~$${spentUsd.toFixed(3)} + sonraki çağrı ~$${next.toFixed(3)} > tavan $${maxCostUsd.toFixed(2)}`);
	}
	return budgetStop;
}

let judgeAdapter: JudgeAdapter | null = null;
if (needsJudge) {
	const providers = JSON.parse(fs.readFileSync(providersPath(), 'utf-8')) as {
		providers: { id: string; baseUrl: string; reasoningDialect: 'think-tags' | 'reasoning_content' | 'none'; timeouts: { connectMs: number; firstTokenMs: number; idleMs: number } }[];
	};
	const entry = providers.providers.find((p) => p.id === 'deepseek-api');
	if (!entry) {
		console.error('data/providers.json içinde deepseek-api girdisi bulunamadı.');
		process.exit(1);
	}
	const apiKey = await secretStore.get('deepseek-api');
	console.log(`[judge] key present: ${apiKey ? 'true' : 'false'}${apiKey ? ` (${maskKey(apiKey)})` : ''}  model: ${judgeModel}`);
	if (!apiKey) {
		console.error('deepseek-api için kayıtlı bir API anahtarı yok — ayarlardan ekleyin.');
		process.exit(1);
	}
	const realAdapter = new OpenAICompatAdapter({
		id: 'deepseek-api',
		baseUrl: entry.baseUrl,
		apiKey,
		reasoningDialect: entry.reasoningDialect,
		// Not the chat's timeouts (connect 5 s): a ~13k-char judge prompt to a reasoning model,
		// behind the machine's HTTPS-scanning antivirus, routinely needs longer before headers.
		timeouts: { connectMs: 60_000, firstTokenMs: 300_000, idleMs: 120_000 }
	});
	const streamOnce = async (prompt: string): Promise<JudgeCallResult> => {
		let content = '';
			let reasoningChars = 0;
			let usage: { promptTokens: number; completionTokens: number } | undefined;
			const controller = new AbortController();
			for await (const chunk of realAdapter.chat(
				{ model: judgeModel, messages: [{ role: 'user', content: prompt }], temperature: 0 },
				controller.signal
			)) {
				if (chunk.type === 'text') content += chunk.text;
				else if (chunk.type === 'reasoning') reasoningChars += chunk.text.length;
				else if (chunk.type === 'usage') usage = { promptTokens: chunk.prompt, completionTokens: chunk.completion };
			}
			const billed = usage ?? {
				promptTokens: Math.ceil(prompt.length / 3),
				completionTokens: Math.ceil((content.length + reasoningChars) / 3)
			};
			if (!usage) usageEstimated = true;
			lastCallUsd = callCostUsd(billed.promptTokens, billed.completionTokens, new Date());
			spentUsd += lastCallUsd;
			return { content, usage: billed };
	};
	judgeAdapter = {
		/** Network errors are retried twice with backoff; after that the attempt returns empty
		 * content, which callJudge treats as an invalid response (-> judge_failed), so one bad
		 * connection costs one item instead of the whole run. A failed attempt is charged the
		 * prompt's estimated input cost, in case it was billed before the connection dropped. */
		async call(prompt: string): Promise<JudgeCallResult> {
			for (let attempt = 1; attempt <= 3; attempt++) {
				try {
					return await streamOnce(prompt);
				} catch (err) {
					spentUsd += callCostUsd(Math.ceil(prompt.length / 3), 0, new Date());
					const message = err instanceof Error ? err.message : String(err);
					console.log(`[judge] ağ hatası (deneme ${attempt}/3): ${message}`);
					if (attempt < 3) await new Promise((r) => setTimeout(r, 5000 * attempt));
				}
			}
			return { content: '' };
		}
	};
}

// ---------------------------------------------------------------------------
// Judge phase
// ---------------------------------------------------------------------------

function toJudgeItem(a: AnswerRecord): JudgeItemInput {
	return {
		type: a.type,
		answerable: a.answerable,
		question: a.question,
		turns: a.turns,
		reference_answer: a.reference_answer,
		chunks: a.sut.chunks.map((c, i) => ({ index: i + 1, topic: c.topic, heading_path: c.heading_path, path: c.path, text: c.text })),
		answer: a.sut.answer
	};
}

if (needsJudge && judgeAdapter) {
	const plannedCalls = answers.length + rejudgeN + (doSanity ? Math.min(3, answers.filter((a) => a.answerable).length) * 2 : 0);
	const plannedChars = answers.reduce((s, a) => s + buildJudgePrompt(toJudgeItem(a)).length, 0);
	console.log(`[judge] planlanan çağrı sayısı: ${plannedCalls}, toplam karakter (ana geçiş, ~): ${plannedChars}`);
}

interface JudgedRecord {
	answer: AnswerRecord;
	judgeFailed: boolean;
	judge?: JudgeResult;
	error?: string;
}

const judgedRecords: JudgedRecord[] = [];
if (needsJudge && judgeAdapter) {
	let done = 0;
	for (const a of answers) {
		if (overBudget()) {
			judgedRecords.push({ answer: a, judgeFailed: true, error: 'bütçe tavanı' });
			continue;
		}
		const outcome = await callJudge(judgeAdapter, toJudgeItem(a));
		usageTotals.promptTokens += outcome.usage.promptTokens;
		usageTotals.completionTokens += outcome.usage.completionTokens;
		usageTotals.calls += outcome.attempts;
		judgedRecords.push({ answer: a, judgeFailed: outcome.judge_failed, judge: outcome.result, error: outcome.error });
		done++;
		console.log(`[judge] ${done}/${answers.length} id=${a.id} ${outcome.judge_failed ? 'JUDGE_FAILED' : `correctness=${outcome.result?.correctness} relevance=${outcome.result?.relevance}`}  harcanan ~$${spentUsd.toFixed(3)}`);
	}
} else {
	for (const a of answers) judgedRecords.push({ answer: a, judgeFailed: true, error: 'judge devre dışı (--no-judge)' });
}

// ---------------------------------------------------------------------------
// --rejudge: self-consistency
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function faithfulnessOf(judge: JudgeResult | undefined): number {
	if (!judge || judge.claims.length === 0) return NaN;
	const total = judge.claims.reduce((s, c) => s + c.support.reduce((m, x) => Math.max(m, x.grade), 0), 0);
	return total / (2 * judge.claims.length);
}

let selfConsistency: ReturnType<typeof computeSelfConsistency> | null = null;
if (needsJudge && judgeAdapter && rejudgeN > 0) {
	const judgedOk = judgedRecords.filter((r) => !r.judgeFailed);
	const rand = mulberry32(1);
	const shuffled = [...judgedOk].sort(() => rand() - 0.5);
	const picked = shuffled.slice(0, Math.min(rejudgeN, shuffled.length));
	const pairs = [];
	for (const rec of picked) {
		if (overBudget()) break;
		const outcome = await callJudge(judgeAdapter, toJudgeItem(rec.answer));
		usageTotals.promptTokens += outcome.usage.promptTokens;
		usageTotals.completionTokens += outcome.usage.completionTokens;
		usageTotals.calls += outcome.attempts;
		if (outcome.judge_failed || !outcome.result || !rec.judge) continue;
		pairs.push({
			correctnessA: rec.judge.correctness,
			correctnessB: outcome.result.correctness,
			faithfulnessA: faithfulnessOf(rec.judge),
			faithfulnessB: faithfulnessOf(outcome.result)
		});
	}
	selfConsistency = computeSelfConsistency(pairs);
	console.log(`[rejudge] n=${pairs.length} tam uyum(correctness)=${selfConsistency.exactAgreementCorrectness.toFixed(2)} |Δ|<=1=${selfConsistency.withinOneCorrectness.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// --sanity: fabricated unsupported sentence must drop faithfulness
// ---------------------------------------------------------------------------

const FABRICATED_SENTENCE =
	// Plausible-sounding and absent from every source — an earlier version announced itself as
	// "uydurma", which only tested whether the judge can read the word.
	' Bu yaklaşım ilk kez 1983 yılında IBM Almaden araştırma laboratuvarında patentlenmiş ve 1986\'dan itibaren tüm büyük işletim sistemlerinde varsayılan hâle gelmiştir.';

let sanityReport: ReturnType<typeof computeSanityCheck> | null = null;
if (needsJudge && judgeAdapter && doSanity) {
	const candidates = judgedRecords.filter((r) => r.answer.answerable && !r.judgeFailed).slice(0, 3);
	const pairs = [];
	for (const rec of candidates) {
		if (overBudget()) break;
		const fabricated: AnswerRecord = { ...rec.answer, sut: { ...rec.answer.sut, answer: rec.answer.sut.answer + FABRICATED_SENTENCE } };
		const outcome = await callJudge(judgeAdapter, toJudgeItem(fabricated));
		usageTotals.promptTokens += outcome.usage.promptTokens;
		usageTotals.completionTokens += outcome.usage.completionTokens;
		usageTotals.calls += outcome.attempts;
		if (outcome.judge_failed || !outcome.result || !rec.judge) continue;
		pairs.push({ faithfulnessBefore: faithfulnessOf(rec.judge), faithfulnessAfter: faithfulnessOf(outcome.result) });
	}
	sanityReport = computeSanityCheck(pairs);
	console.log(`[sanity] n=${sanityReport.n} ortalama düşüş=${sanityReport.meanDrop.toFixed(3)} hepsi düştü mü=${sanityReport.allDropped}`);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const genItems: GenItem[] = judgedRecords.map((r) => {
	// Restricted to the two golden languages: the question is only "Turkish or English?", and
	// franc-min's full-set margin gate rejected 69/70 long technical answers (mixed terms, code,
	// LaTeX) as unreliable, leaving the metric at n=1.
	const answerText = stripForDetection((r.answer.sut.answer ?? '').replace(/<think>[\s\S]*?<\/think>/g, ''));
	const detection =
		countLetters(answerText) >= 20
			? { reliable: true, iso3: francAll(answerText, { only: ['tur', 'eng'], minLength: 1 })[0][0] }
			: { reliable: false, iso3: undefined };
	return {
		id: r.answer.id,
		type: r.answer.type,
		lang: r.answer.lang,
		answerable: r.answer.answerable,
		numChunks: r.answer.sut.chunks.length,
		judge: r.judge,
		judgeFailed: r.judgeFailed,
		detectedAnswerLang: { reliable: detection.reliable, iso3: detection.iso3 }
	};
});

const timings: TimingRecord[] = answers.map((a) => ({
	ttftMs: a.sut.timings.ttftMs,
	generationMs: a.sut.timings.generationMs,
	totalMs: a.sut.timings.totalMs,
	tokPerSec: a.sut.ollamaStats.tokPerSec
}));

const hallucination = computeHallucination(genItems);
const correctness = computeCorrectness(genItems);
const relevance = computeRelevance(genItems);
const abstention = computeAbstention(genItems);
const smalltalkCompliance = computeSmalltalkCompliance(genItems);
const citation = computeCitation(genItems);
const contextRelevance = computeContextRelevance(genItems);
const responseLanguageCompliance = computeResponseLanguageCompliance(genItems);
const multiHopAccuracy = computeTypeAccuracy(genItems, 'multi_hop');
const crossDocAccuracy = computeTypeAccuracy(genItems, 'cross_document');
const performance = computePerformance(timings);

function bySlice<K extends string>(keyOf: (i: GenItem) => K, fn: (items: GenItem[]) => unknown): Record<string, unknown> {
	const groups = new Map<string, GenItem[]>();
	for (const i of genItems) {
		const k = keyOf(i);
		const arr = groups.get(k) ?? [];
		arr.push(i);
		groups.set(k, arr);
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of groups) out[k] = fn(v);
	return out;
}
const byType = bySlice(
	(i) => i.type,
	(v) => ({ correctness: computeCorrectness(v), relevance: computeRelevance(v), faithfulness: computeHallucination(v).faithfulness })
);
const byLang = bySlice(
	(i) => i.lang,
	(v) => ({ correctness: computeCorrectness(v), relevance: computeRelevance(v), faithfulness: computeHallucination(v).faithfulness })
);

// ---------------------------------------------------------------------------
// Pooled qrels — judged grade-2 chunks not already in the golden set
// ---------------------------------------------------------------------------

const goldenById = new Map(items.map((i) => [i.id, i]));
const pooledLines: string[] = [];
for (const r of judgedRecords) {
	if (r.judgeFailed || !r.judge) continue;
	const golden = goldenById.get(r.answer.id);
	const goldenAnchors = new Set((golden?.relevant ?? []).map((rel) => rel.anchor));
	for (const cr of judgedGrade2Chunks([
		{
			id: r.answer.id,
			type: r.answer.type,
			lang: r.answer.lang,
			answerable: r.answer.answerable,
			numChunks: r.answer.sut.chunks.length,
			judge: r.judge
		}
	])) {
		const chunk = r.answer.sut.chunks[cr.chunkIndex - 1];
		if (!chunk) continue;
		if (goldenAnchors.has(chunk.anchor)) continue;
		pooledLines.push(JSON.stringify({ id: r.answer.id, anchor: chunk.anchor, path: chunk.path, heading_path: chunk.heading_path, grade: 2 }));
	}
}
if (pooledLines.length > 0) {
	fs.writeFileSync(path.join(outDir, 'pooled-qrels.jsonl'), pooledLines.join('\n') + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Isolation check + index.db size
// ---------------------------------------------------------------------------

const after = watchedPaths.map(snapshot);
console.log('[isolation] sonra:', JSON.stringify(after));
let isolationOk = true;
for (let i = 0; i < watchedPaths.length; i++) {
	const b = before[i];
	const a = after[i];
	if (b.exists !== a.exists || b.size !== a.size || b.mtimeMs !== a.mtimeMs) {
		isolationOk = false;
		console.error(`[isolation] DEĞİŞTİ: ${watchedPaths[i]} önce=${JSON.stringify(b)} sonra=${JSON.stringify(a)}`);
	}
}
if (isolationOk) console.log('[isolation] OK — chats.db / index.db / study.db değişmedi');

let indexDbSizeBytes: number | undefined;
try {
	indexDbSizeBytes = fs.statSync(vault.indexDbPath).size;
} catch {
	indexDbSizeBytes = undefined;
}

function gitSha(): string | undefined {
	try {
		return execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const report = {
	settings: {
		vault: vaultId,
		file: file ?? null,
		answersInput: answersInputPath ?? null,
		label,
		limit: limit ?? null,
		model,
		judgeModel: needsJudge ? judgeModel : null,
		judged: needsJudge,
		allowCloud: allowCloud ?? null,
		rejudgeN,
		sanity: doSanity
	},
	gitSha: gitSha(),
	datasetSha1: datasetSha1 || undefined,
	judgePromptSha1: needsJudge ? judgePromptSha1() : undefined,
	deviations,
	generatedAt: new Date().toISOString(),
	counts: { total: answers.length, judged: judgedRecords.filter((r) => !r.judgeFailed).length, judgeFailed: judgedRecords.filter((r) => r.judgeFailed).length },
	aggregates: {
		hallucination,
		correctness,
		relevance,
		abstention,
		smalltalkCompliance,
		citation,
		contextRelevance,
		responseLanguageCompliance,
		multiHopAccuracy,
		crossDocAccuracy,
		performance,
		byType,
		byLang,
		selfConsistency,
		sanity: sanityReport,
		judgeCost: needsJudge ? { promptTokens: usageTotals.promptTokens, completionTokens: usageTotals.completionTokens, calls: usageTotals.calls, estimatedUsd: spentUsd, maxCostUsd, usageEstimated, budgetStop } : undefined
	},
	perf: { indexDbSizeBytes },
	isolation: { before, after, ok: isolationOk },
	items: judgedRecords.map((r) => ({
		id: r.answer.id,
		type: r.answer.type,
		lang: r.answer.lang,
		answerable: r.answer.answerable,
		question: r.answer.question,
		answerPreview: r.answer.sut.answer.slice(0, 300),
		timings: r.answer.sut.timings,
		ollamaStats: r.answer.sut.ollamaStats,
		numChunks: r.answer.sut.chunks.length,
		judgeFailed: r.judgeFailed,
		judge: r.judge,
		peak: r.answer.sut.resourceSamples.length
			? {
					gpuMemUsedMb: Math.max(0, ...r.answer.sut.resourceSamples.map((s) => s.gpuMemUsedMb ?? 0)),
					gpuUtilPct: Math.max(0, ...r.answer.sut.resourceSamples.map((s) => s.gpuUtilPct ?? 0)),
					rssMb: Math.max(0, ...r.answer.sut.resourceSamples.map((s) => s.rssMb))
				}
			: undefined
	}))
};

fs.writeFileSync(path.join(outDir, 'generation.json'), JSON.stringify(report, null, 2), 'utf-8');

// --- Markdown ---------------------------------------------------------------

function fmt(x: number | undefined | null): string {
	return x === undefined || x === null || Number.isNaN(x) ? 'n/a' : x.toFixed(3);
}
function fmtSummary(s: { mean: number; lo: number; hi: number; n: number }): string {
	return `${fmt(s.mean)} [${fmt(s.lo)}, ${fmt(s.hi)}] (n=${s.n})`;
}

const md: string[] = [];
md.push(`# Generation Benchmark — ${label}`);
md.push('');
md.push(`Vault: \`${vaultId}\` · Model: \`${model}\`${needsJudge ? ` · Yargıç: \`${judgeModel}\` (deepseek-api)` : ' · Yargıç: yok (--no-judge)'}`);
md.push(`Git SHA: \`${report.gitSha ?? 'yok'}\`${datasetSha1 ? ` · Dataset SHA1: \`${datasetSha1}\`` : ''}${needsJudge ? ` · Judge prompt SHA1: \`${judgePromptSha1()}\`` : ''}`);
md.push(`Toplam: ${answers.length}, yargılanan: ${report.counts.judged}, judge_failed: ${report.counts.judgeFailed}`);
md.push('');

md.push('## Sapmalar (gerçek /api/chat rotasından)');
md.push('');
for (const d of deviations) md.push(`- ${d}`);
md.push('');

md.push('## GENERATION');
md.push('');
md.push('| Metrik | Değer |');
md.push('|---|---|');
md.push(`| Correctness (mean, answerable) | ${fmtSummary(correctness.mean)} |`);
md.push(`| Correctness ≥4 payı | ${fmtSummary(correctness.shareAtLeast4)} |`);
md.push(`| Relevance (mean) | ${fmtSummary(relevance.mean)} |`);
md.push(`| Relevance ≥4 payı | ${fmtSummary(relevance.shareAtLeast4)} |`);
md.push(`| Abstention accuracy (unanswerable) | ${fmt(abstention.abstentionAccuracy)} |`);
md.push(`| False-abstention rate (answerable) | ${fmt(abstention.falseAbstentionRate)} |`);
md.push(`| Smalltalk uyumu | ${fmt(smalltalkCompliance)} |`);
md.push(`| Response-language uyumu | ${fmtSummary(responseLanguageCompliance)} |`);
md.push('');

md.push('## CITATION');
md.push('');
md.push('| Metrik | Değer |');
md.push('|---|---|');
md.push(`| Source-list precision | ${fmtSummary(citation.sourceListPrecision)} |`);
md.push(`| Citation recall | ${fmtSummary(citation.citationRecall)} |`);
md.push(`| Mention precision | ${fmtSummary(citation.mentionPrecision)} |`);
md.push(`| Context relevance (chunk grade≥1) | ${fmtSummary(contextRelevance)} |`);
md.push(`| Entailment dağılımı (0/1/2) | ${citation.entailmentDistribution.grade0}/${citation.entailmentDistribution.grade1}/${citation.entailmentDistribution.grade2} (toplam ${citation.entailmentDistribution.total}) |`);
md.push('');

md.push('## HALLUCINATION');
md.push('');
md.push('| Metrik | Değer |');
md.push('|---|---|');
md.push(`| Faithfulness | ${fmtSummary(hallucination.faithfulness)} |`);
md.push(`| Unsupported-claim rate | ${fmtSummary(hallucination.unsupportedClaimRate)} |`);
md.push(`| Hallucination rate (answerable) | ${fmt(hallucination.hallucinationRateAnswerable)} |`);
md.push(`| Hallucination rate (unanswerable) | ${fmt(hallucination.hallucinationRateUnanswerable)} |`);
md.push('');

md.push('## MULTI-HOP / CROSS-DOCUMENT');
md.push('');
md.push('| Tür | Correctness ≥4 payı |');
md.push('|---|---|');
md.push(`| multi_hop | ${fmtSummary(multiHopAccuracy)} |`);
md.push(`| cross_document | ${fmtSummary(crossDocAccuracy)} |`);
md.push('');

md.push('## PERFORMANCE');
md.push('');
md.push('| Metrik | P50 | P95 |');
md.push('|---|---|---|');
md.push(`| TTFT (ms) | ${fmt(performance.ttftP50)} | ${fmt(performance.ttftP95)} |`);
md.push(`| Üretim süresi (ms) | ${fmt(performance.generationMsP50)} | ${fmt(performance.generationMsP95)} |`);
md.push(`| Toplam süre (ms) | ${fmt(performance.totalMsP50)} | ${fmt(performance.totalMsP95)} |`);
md.push(`| tok/s | ${fmt(performance.tokPerSecP50)} | ${fmt(performance.tokPerSecP95)} |`);
md.push('');
md.push(`index.db boyutu: ${indexDbSizeBytes !== undefined ? `${(indexDbSizeBytes / 1e6).toFixed(1)} MB` : 'n/a'}`);
md.push('');

if (needsJudge) {
	md.push('## Yargıç maliyeti');
	md.push('');
	md.push(`Toplam çağrı: ${usageTotals.calls}, prompt token: ${usageTotals.promptTokens}, completion token: ${usageTotals.completionTokens}`);
	md.push(`Tahmini maliyet: ~$${spentUsd.toFixed(3)} (tavan $${maxCostUsd.toFixed(2)}${usageEstimated ? ', token sayıları karakterden tahmin edildi' : ''}${budgetStop ? ', TAVANDA DURDURULDU' : ''})`);
	md.push('');
}

if (selfConsistency) {
	md.push('## Self-consistency (--rejudge)');
	md.push('');
	md.push(`n=${selfConsistency.n}, tam uyum (correctness)=${fmt(selfConsistency.exactAgreementCorrectness)}, |Δ|≤1=${fmt(selfConsistency.withinOneCorrectness)}, ortalama |Δ faithfulness|=${fmt(selfConsistency.meanAbsDeltaFaithfulness)}`);
	md.push('');
}

if (sanityReport) {
	md.push('## Sanity check (--sanity)');
	md.push('');
	md.push(`n=${sanityReport.n}, ortalama faithfulness düşüşü=${fmt(sanityReport.meanDrop)}, hepsi düştü mü=${sanityReport.allDropped}`);
	md.push('');
}

md.push('## İzolasyon');
md.push('');
md.push(isolationOk ? 'chats.db / index.db / study.db çalıştırma boyunca değişmedi.' : '**UYARI: bir veya daha fazla dosya değişti.**');
md.push('');

fs.writeFileSync(path.join(outDir, 'generation.md'), md.join('\n'), 'utf-8');

console.log(`\nÇıktı: ${outDir}`);
console.log('  answers.jsonl');
console.log('  generation.json');
console.log('  generation.md');
if (pooledLines.length > 0) console.log('  pooled-qrels.jsonl');
