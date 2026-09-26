/**
 * RAG retrieval benchmark CLI.
 *
 *   npx tsx bench/run-retrieval.ts --vault default --file <a.jsonl> [--file <b.jsonl>]
 *     [--variants prod,prod+kw,vector-raw,bm25,hybrid,vector+rerank,hybrid+rerank,hybrid+rerank+qx]
 *     [--rerank-device cuda|cpu] [--rerank-dtype fp16|fp32] [--label <name>] [--limit N]
 *
 * Validates every golden file against the live index (schema + anchor
 * resolution, same rules as validate-golden.ts), runs every requested
 * pipeline variant (bench/lib/pipelines.ts) over every item, scores each
 * variant chunk- and file-level against the golden qrels (bench/lib/metrics.ts),
 * and writes a timestamped report under
 * data/vaults/default/bench/results/<ISO>-<label>/{retrieval.json,retrieval.md}.
 *
 * Opens index.db strictly read-only; never writes to any app data file other
 * than its own results/cache directories under data/vaults/default/bench/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { resolveVault } from '../src/lib/server/vaults';
import { dataDir } from '../src/lib/server/env';
import { buildAnchorIndex, resolveQrels, type QrelLabel } from './lib/anchor';
import { parseGoldenLine, checkAnswerabilityRules, type GoldenLine } from './dataset/golden';
import {
	recallAtK,
	precisionAtK,
	hitAtK,
	reciprocalRankAtK,
	ndcgAtK,
	mean,
	bootstrapCI,
	pairedRandomizationTest,
	type Relevance
} from './lib/metrics';
import {
	openPipelineContext,
	closePipelineContext,
	PIPELINES,
	RERANK_VARIANTS,
	VARIANT_NAMES,
	percentile,
	type VariantName,
	type PipelineContext,
	type PipelineOutput,
	type QueryItem
} from './lib/pipelines';
import { EmbedCache } from './lib/embed-cache';
import { RerankerClient, type RerankerStats } from './lib/reranker';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i !== -1 ? argv[i + 1] : undefined;
}
function argValues(flag: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) if (argv[i] === flag) out.push(argv[i + 1]);
	return out;
}

const vaultId = argValue('--vault') ?? 'default';
const files = argValues('--file');
const variantsArg = argValue('--variants');
const rerankDevice = (argValue('--rerank-device') ?? 'cuda') as 'cuda' | 'cpu';
const rerankDtype = (argValue('--rerank-dtype') ?? (rerankDevice === 'cpu' ? 'fp32' : 'fp16')) as 'fp16' | 'fp32';
const label = argValue('--label') ?? 'run';
const limitArg = argValue('--limit');
const limit = limitArg ? Number(limitArg) : undefined;

if (files.length === 0) {
	console.error('en az bir --file <golden.jsonl> gerekli');
	process.exit(1);
}

const selectedVariants: VariantName[] = (variantsArg ? (variantsArg.split(',') as VariantName[]) : [...VARIANT_NAMES]);
for (const v of selectedVariants) {
	if (!VARIANT_NAMES.includes(v)) {
		console.error(`--variants geçersiz değer: ${v} (beklenen: ${VARIANT_NAMES.join(', ')})`);
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// Isolation snapshot — asserted unchanged at the very end
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

const vault = resolveVault(vaultId);
const watchedPaths = [path.join(dataDir(), 'chats.db'), vault.indexDbPath, vault.studyDbPath];
const before = watchedPaths.map(snapshot);
console.log('[isolation] önce:', JSON.stringify(before));

// ---------------------------------------------------------------------------
// Load + validate golden files
// ---------------------------------------------------------------------------

if (!fs.existsSync(vault.indexDbPath)) {
	console.error(`index.db yok: ${vault.indexDbPath}`);
	process.exit(1);
}

const rawByFile = new Map<string, string>();
const allLines: GoldenLine[] = [];
let schemaErrors = 0;
for (const filePath of files) {
	if (!fs.existsSync(filePath)) {
		console.error(`dosya yok: ${filePath}`);
		process.exit(1);
	}
	const raw = fs.readFileSync(filePath, 'utf-8');
	rawByFile.set(filePath, raw);
	const rawLines = raw.split('\n').filter((l) => l.trim().length > 0);
	for (let i = 0; i < rawLines.length; i++) {
		const { line, errors } = parseGoldenLine(rawLines[i], i + 1);
		if (errors.length > 0) {
			schemaErrors += errors.length;
			for (const e of errors) console.error(`[${filePath}] ${e}`);
			continue;
		}
		const ruleErrors = checkAnswerabilityRules(line!);
		if (ruleErrors.length > 0) {
			schemaErrors += ruleErrors.length;
			for (const e of ruleErrors) console.error(`[${filePath}] ${e}`);
			continue;
		}
		allLines.push(line!);
	}
}
if (schemaErrors > 0) {
	console.error(`\n${schemaErrors} şema/kural hatası bulundu — çalıştırma durduruldu.`);
	process.exit(1);
}

const idCounts = new Map<string, number>();
for (const l of allLines) idCounts.set(l.id, (idCounts.get(l.id) ?? 0) + 1);
for (const [id, count] of idCounts) {
	if (count > 1) {
		console.error(`id '${id}' birden fazla dosyada/satırda tekrarlanıyor (${count})`);
		process.exit(1);
	}
}

console.log(`[golden] ${files.length} dosya, ${allLines.length} soru yüklendi`);

// Anchor resolution against the live index — items whose relevant labels are
// ALL unresolvable ('missing') are dropped from ranking metrics (they carry
// no usable ground truth) and reported, per the build brief.
const anchorDb = new Database(vault.indexDbPath, { readonly: true, fileMustExist: true });
const anchorIndex = buildAnchorIndex(anchorDb);
const pathToDomains = new Map(
	(anchorDb.prepare('SELECT path, domains_json FROM files').all() as { path: string; domains_json: string }[]).map(
		(r) => [r.path, JSON.parse(r.domains_json) as string[]]
	)
);

interface ItemRelevance {
	item: GoldenLine;
	chunkRelevance: Relevance;
	fileRelevance: Relevance;
	missingAnchors: string[];
	domain: string;
}

function primaryDomain(item: GoldenLine): string {
	const counts = new Map<string, number>();
	for (const r of item.relevant) {
		for (const d of pathToDomains.get(r.path) ?? []) counts.set(d, (counts.get(d) ?? 0) + 1);
	}
	if (counts.size === 0) return 'unknown';
	return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))[0][0];
}

function buildItemRelevance(item: GoldenLine): ItemRelevance {
	const chunkRelevance: Relevance = new Map();
	const fileOnlyExtra: Relevance = new Map();
	const missingAnchors: string[] = [];
	const labels: QrelLabel[] = item.relevant.map((r) => ({ anchor: r.anchor, path: r.path, grade: r.grade }));
	const resolved = resolveQrels(labels, anchorIndex);
	for (const r of resolved) {
		if (r.status === 'exact') {
			const current = chunkRelevance.get(r.anchor);
			if (current === undefined || r.grade > current) chunkRelevance.set(r.anchor, r.grade);
		} else if (r.status === 'file-only') {
			const current = fileOnlyExtra.get(r.path);
			if (current === undefined || r.grade > current) fileOnlyExtra.set(r.path, r.grade);
		} else {
			missingAnchors.push(r.anchor);
		}
	}
	const fileRelevance: Relevance = new Map();
	for (const [anchor, grade] of chunkRelevance) {
		const p = anchorIndex.pathOf(anchor);
		if (p === undefined) continue;
		const current = fileRelevance.get(p);
		if (current === undefined || grade > current) fileRelevance.set(p, grade);
	}
	for (const [p, grade] of fileOnlyExtra) {
		const current = fileRelevance.get(p);
		if (current === undefined || grade > current) fileRelevance.set(p, grade);
	}
	return { item, chunkRelevance, fileRelevance, missingAnchors, domain: primaryDomain(item) };
}

const itemRelevance = new Map<string, ItemRelevance>();
let totalMissing = 0;
let skippedItems = 0;
for (const item of allLines) {
	const rel = buildItemRelevance(item);
	itemRelevance.set(item.id, rel);
	totalMissing += rel.missingAnchors.length;
	if (item.answerable && rel.chunkRelevance.size === 0 && rel.fileRelevance.size === 0) {
		skippedItems++;
		console.warn(`[skip] id=${item.id}: tüm relevant etiketleri 'missing' — sıralama metriklerinden çıkarıldı`);
	}
}
if (totalMissing > 0) console.warn(`[golden] ${totalMissing} relevant etiketi indekste bulunamadı (missing)`);
anchorDb.close();

const items = limit !== undefined ? allLines.slice(0, limit) : allLines;

const eligibleForRanking = items.filter((i) => {
	const rel = itemRelevance.get(i.id)!;
	return i.answerable && (rel.chunkRelevance.size > 0 || rel.fileRelevance.size > 0);
});
const unanswerableItems = items.filter((i) => !i.answerable);

console.log(
	`[golden] toplam=${items.length} answerable(kullanılabilir)=${eligibleForRanking.length} unanswerable=${unanswerableItems.length} atlanan=${skippedItems}`
);

// ---------------------------------------------------------------------------
// Pipeline context + reranker
// ---------------------------------------------------------------------------

const needsReranker = selectedVariants.some((v) => RERANK_VARIANTS.includes(v));
let reranker: RerankerClient | undefined;
let rerankerLoadMs = 0;
if (needsReranker) {
	reranker = new RerankerClient({ device: rerankDevice, dtype: rerankDtype });
	console.log(`[reranker] başlatılıyor (${rerankDevice}/${rerankDtype})...`);
	const { loadMs } = await reranker.start();
	rerankerLoadMs = loadMs;
	console.log(`[reranker] hazır (${loadMs.toFixed(0)} ms)`);
}

const embedCache = new EmbedCache();
const ctx: PipelineContext = openPipelineContext(vault, { embedCache, reranker });

// ---------------------------------------------------------------------------
// Run every item x variant
// ---------------------------------------------------------------------------

interface RunRecord {
	output: PipelineOutput;
}

const runsByVariant = new Map<VariantName, Map<string, RunRecord>>();
for (const v of selectedVariants) runsByVariant.set(v, new Map());

let processed = 0;
const totalRuns = items.length * selectedVariants.length;
for (const item of items) {
	const queryItem: QueryItem = { question: item.question, turns: item.turns };
	for (const variant of selectedVariants) {
		let output: PipelineOutput;
		try {
			output = await PIPELINES[variant](ctx, queryItem);
		} catch (err) {
			console.error(`[${variant}] id=${item.id} hata: ${err instanceof Error ? err.message : String(err)}`);
			output = { ranked: [], timings: { totalMs: 0 }, meta: { error: err instanceof Error ? err.message : String(err) } };
		}
		runsByVariant.get(variant)!.set(item.id, { output });
		processed++;
		if (processed % 25 === 0 || processed === totalRuns) {
			console.log(`[run] ${processed}/${totalRuns}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const METRIC_KEYS = ['recall1', 'recall3', 'recall5', 'recall10', 'precision5', 'precision10', 'hit5', 'mrr10', 'ndcg5', 'ndcg10'] as const;
type MetricKey = (typeof METRIC_KEYS)[number];
type MetricRow = Record<MetricKey, number | null>;

function dedupeToFilesFromRanked(ranked: { path: string }[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of ranked) {
		if (seen.has(r.path)) continue;
		seen.add(r.path);
		out.push(r.path);
	}
	return out;
}

function computeMetricRow(retrieved: string[], relevance: Relevance): MetricRow {
	return {
		recall1: recallAtK(retrieved, relevance, 1),
		recall3: recallAtK(retrieved, relevance, 3),
		recall5: recallAtK(retrieved, relevance, 5),
		recall10: recallAtK(retrieved, relevance, 10),
		precision5: precisionAtK(retrieved, relevance, 5),
		precision10: precisionAtK(retrieved, relevance, 10),
		hit5: hitAtK(retrieved, relevance, 5),
		mrr10: reciprocalRankAtK(retrieved, relevance, 10),
		ndcg5: ndcgAtK(retrieved, relevance, 5),
		ndcg10: ndcgAtK(retrieved, relevance, 10)
	};
}

interface ItemMetric {
	id: string;
	type: string;
	lang: string;
	domain: string;
	chunk: MetricRow;
	file: MetricRow;
}

function metricsForVariant(variant: VariantName): ItemMetric[] {
	const runs = runsByVariant.get(variant)!;
	const out: ItemMetric[] = [];
	for (const item of eligibleForRanking) {
		const rel = itemRelevance.get(item.id)!;
		const run = runs.get(item.id)!;
		const chunkRetrieved = run.output.ranked.map((r) => r.anchor);
		const fileRetrieved = dedupeToFilesFromRanked(run.output.ranked);
		out.push({
			id: item.id,
			type: item.type,
			lang: item.lang,
			domain: rel.domain,
			chunk: computeMetricRow(chunkRetrieved, rel.chunkRelevance),
			file: computeMetricRow(fileRetrieved, rel.fileRelevance)
		});
	}
	return out;
}

interface Summary {
	mean: number;
	n: number;
	lo: number;
	hi: number;
}

function summarize(values: (number | null)[], seed = 1): Summary {
	const nums = values.filter((v): v is number => v !== null);
	const { mean: m, n } = mean(values);
	const ci = nums.length > 0 ? bootstrapCI(nums, { seed }) : { mean: NaN, lo: NaN, hi: NaN };
	return { mean: m, n, lo: ci.lo, hi: ci.hi };
}

function aggregate(rows: ItemMetric[], level: 'chunk' | 'file'): Record<MetricKey, Summary> {
	const out = {} as Record<MetricKey, Summary>;
	for (const key of METRIC_KEYS) out[key] = summarize(rows.map((r) => r[level][key]));
	return out;
}

function groupBy<T, K extends string>(rows: T[], keyOf: (r: T) => K): Map<K, T[]> {
	const m = new Map<K, T[]>();
	for (const r of rows) {
		const k = keyOf(r);
		const arr = m.get(k);
		if (arr) arr.push(r);
		else m.set(k, [r]);
	}
	return m;
}

interface VariantReport {
	variant: VariantName;
	chunk: Record<MetricKey, Summary>;
	file: Record<MetricKey, Summary>;
	byType: Record<string, { chunk: Record<MetricKey, Summary>; file: Record<MetricKey, Summary> }>;
	byLang: Record<string, { chunk: Record<MetricKey, Summary>; file: Record<MetricKey, Summary> }>;
	byDomain: Record<string, { chunk: Record<MetricKey, Summary>; file: Record<MetricKey, Summary> }>;
	vsProd?: { recall5_p: number; ndcg10_p: number };
	abstention: { unanswerableEmptyRate: number; answerableFalseEmptyRate: number };
	latency: {
		cold: Record<string, number>;
		warm: Record<string, { p50: number; p95: number; n: number }>;
	};
	rerankQuantiles?: { answerable: number[]; unanswerable: number[] };
}

const variantMetrics = new Map<VariantName, ItemMetric[]>();
for (const v of selectedVariants) variantMetrics.set(v, metricsForVariant(v));

const prodMetrics = variantMetrics.get('prod');

function computeVsProd(rows: ItemMetric[]): { recall5_p: number; ndcg10_p: number } | undefined {
	if (!prodMetrics || prodMetrics.length !== rows.length) return undefined;
	const a5 = rows.map((r) => r.chunk.recall5).filter((v): v is number => v !== null);
	const b5 = prodMetrics.map((r) => r.chunk.recall5).filter((v): v is number => v !== null);
	const a10 = rows.map((r) => r.chunk.ndcg10).filter((v): v is number => v !== null);
	const b10 = prodMetrics.map((r) => r.chunk.ndcg10).filter((v): v is number => v !== null);
	if (a5.length !== b5.length || a10.length !== b10.length || a5.length === 0) return undefined;
	return {
		recall5_p: pairedRandomizationTest(a5, b5, { seed: 1 }),
		ndcg10_p: pairedRandomizationTest(a10, b10, { seed: 1 })
	};
}

function abstentionFor(variant: VariantName): { unanswerableEmptyRate: number; answerableFalseEmptyRate: number } {
	const runs = runsByVariant.get(variant)!;
	const unanswerableEmpty = unanswerableItems.filter((i) => (runs.get(i.id)?.output.ranked.length ?? 0) === 0).length;
	const answerableFalseEmpty = eligibleForRanking.filter((i) => (runs.get(i.id)?.output.ranked.length ?? 0) === 0).length;
	return {
		unanswerableEmptyRate: unanswerableItems.length > 0 ? unanswerableEmpty / unanswerableItems.length : NaN,
		answerableFalseEmptyRate: eligibleForRanking.length > 0 ? answerableFalseEmpty / eligibleForRanking.length : NaN
	};
}

const TIMING_FIELDS = ['embedMs', 'knnMs', 'ftsMs', 'rerankMs', 'qxMs', 'totalMs'] as const;

function latencyFor(variant: VariantName): VariantReport['latency'] {
	const runs = items.map((i) => runsByVariant.get(variant)!.get(i.id)!.output.timings);
	const cold: Record<string, number> = {};
	if (runs.length > 0) {
		for (const f of TIMING_FIELDS) {
			const v = runs[0][f];
			if (v !== undefined) cold[f] = v;
		}
	}
	const warmRuns = runs.slice(1);
	const warm: Record<string, { p50: number; p95: number; n: number }> = {};
	for (const f of TIMING_FIELDS) {
		const values = warmRuns.map((r) => r[f]).filter((v): v is number => v !== undefined);
		if (values.length === 0) continue;
		warm[f] = { p50: percentile(values, 50), p95: percentile(values, 95), n: values.length };
	}
	return { cold, warm };
}

function rerankQuantilesFor(variant: VariantName): { answerable: number[]; unanswerable: number[] } | undefined {
	if (!RERANK_VARIANTS.includes(variant)) return undefined;
	const runs = runsByVariant.get(variant)!;
	const qs = [10, 25, 50, 75, 90];
	const answerableScores = eligibleForRanking
		.map((i) => runs.get(i.id)?.output.ranked[0]?.score)
		.filter((v): v is number => v !== undefined);
	const unanswerableScores = unanswerableItems
		.map((i) => runs.get(i.id)?.output.ranked[0]?.score)
		.filter((v): v is number => v !== undefined);
	return {
		answerable: qs.map((q) => percentile(answerableScores, q)),
		unanswerable: qs.map((q) => percentile(unanswerableScores, q))
	};
}

const variantReports: VariantReport[] = selectedVariants.map((variant) => {
	const rows = variantMetrics.get(variant)!;
	const byType = new Map<string, ItemMetric[]>();
	for (const [k, v] of groupBy(rows, (r) => r.type)) byType.set(k, v);
	const byLang = groupBy(rows, (r) => r.lang);
	const byDomain = groupBy(rows, (r) => r.domain);

	const toBreakdown = (m: Map<string, ItemMetric[]>) => {
		const out: Record<string, { chunk: Record<MetricKey, Summary>; file: Record<MetricKey, Summary> }> = {};
		for (const [k, v] of m) out[k] = { chunk: aggregate(v, 'chunk'), file: aggregate(v, 'file') };
		return out;
	};

	return {
		variant,
		chunk: aggregate(rows, 'chunk'),
		file: aggregate(rows, 'file'),
		byType: toBreakdown(byType),
		byLang: toBreakdown(byLang),
		byDomain: toBreakdown(byDomain),
		vsProd: variant === 'prod' ? undefined : computeVsProd(rows),
		abstention: abstentionFor(variant),
		latency: latencyFor(variant),
		rerankQuantiles: rerankQuantilesFor(variant)
	};
});

// ---------------------------------------------------------------------------
// Threshold sweep (vector-raw only)
// ---------------------------------------------------------------------------

interface ThresholdRow {
	threshold: number;
	unanswerableEmptyRate: number;
	answerableFalseEmptyRate: number;
	recall5: number;
}

const MAX_CHUNKS_PER_FILE = 3; // mirrors select-chunks.ts

function applyThresholdAndCap(candidates: { anchor: string; path: string; distance: number }[], threshold: number): string[] {
	const perFile = new Map<string, number>();
	const out: string[] = [];
	for (const c of candidates) {
		if (c.distance > threshold) continue;
		const count = perFile.get(c.path) ?? 0;
		if (count >= MAX_CHUNKS_PER_FILE) continue;
		perFile.set(c.path, count + 1);
		out.push(c.anchor);
	}
	return out;
}

let thresholdSweep: ThresholdRow[] | undefined;
if (selectedVariants.includes('vector-raw')) {
	const runs = runsByVariant.get('vector-raw')!;
	const thresholds = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
	thresholdSweep = thresholds.map((t) => {
		let unanswerableEmpty = 0;
		const recalls: (number | null)[] = [];
		let answerableFalseEmpty = 0;
		for (const item of unanswerableItems) {
			const cands = (runs.get(item.id)?.output.meta?.candidates as { anchor: string; path: string; distance: number }[]) ?? [];
			if (applyThresholdAndCap(cands, t).length === 0) unanswerableEmpty++;
		}
		for (const item of eligibleForRanking) {
			const rel = itemRelevance.get(item.id)!;
			const cands = (runs.get(item.id)?.output.meta?.candidates as { anchor: string; path: string; distance: number }[]) ?? [];
			const thresholded = applyThresholdAndCap(cands, t);
			if (thresholded.length === 0) answerableFalseEmpty++;
			recalls.push(recallAtK(thresholded, rel.chunkRelevance, 5));
		}
		return {
			threshold: t,
			unanswerableEmptyRate: unanswerableItems.length > 0 ? unanswerableEmpty / unanswerableItems.length : NaN,
			answerableFalseEmptyRate: eligibleForRanking.length > 0 ? answerableFalseEmpty / eligibleForRanking.length : NaN,
			recall5: mean(recalls).mean
		};
	});
}

// ---------------------------------------------------------------------------
// Reranker stats
// ---------------------------------------------------------------------------

let rerankerStats: RerankerStats | undefined;
if (reranker) {
	try {
		rerankerStats = await reranker.stats();
	} catch (err) {
		console.error(`[reranker] stats() başarısız: ${err instanceof Error ? err.message : String(err)}`);
	}
	reranker.close();
}
closePipelineContext(ctx);

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function gitSha(): string | undefined {
	try {
		return execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
	} catch {
		return undefined;
	}
}

function datasetSha1(): string {
	const hash = createHash('sha1');
	for (const f of files) hash.update(f + '\u0000' + (rawByFile.get(f) ?? ''));
	return hash.digest('hex');
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(dataDir(), 'vaults', 'default', 'bench', 'results', `${timestamp}-${label}`);
fs.mkdirSync(outDir, { recursive: true });

const perItemRecords = items.map((item) => {
	const rel = itemRelevance.get(item.id)!;
	const perVariant: Record<string, unknown> = {};
	for (const variant of selectedVariants) {
		const output = runsByVariant.get(variant)!.get(item.id)!.output;
		perVariant[variant] = { ranked: output.ranked, timings: output.timings, meta: output.meta && output.meta.candidates ? undefined : output.meta };
	}
	return {
		id: item.id,
		type: item.type,
		lang: item.lang,
		difficulty: item.difficulty,
		answerable: item.answerable,
		domain: rel.domain,
		eligible: eligibleForRanking.includes(item),
		perVariant
	};
});

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

const report = {
	settings: {
		vault: vaultId,
		files,
		variants: selectedVariants,
		rerankDevice,
		rerankDtype,
		label,
		limit: limit ?? null,
		poolSize: ctx.poolSize
	},
	gitSha: gitSha(),
	datasetSha1: datasetSha1(),
	generatedAt: new Date().toISOString(),
	counts: {
		total: items.length,
		eligibleForRanking: eligibleForRanking.length,
		unanswerable: unanswerableItems.length,
		skipped: skippedItems,
		missingAnchors: totalMissing
	},
	variantReports,
	thresholdSweep,
	rerankerStats,
	rerankerLoadMs: needsReranker ? rerankerLoadMs : undefined,
	isolation: { before, after, ok: isolationOk },
	items: perItemRecords
};

fs.writeFileSync(path.join(outDir, 'retrieval.json'), JSON.stringify(report, null, 2), 'utf-8');

// --- Markdown report ---------------------------------------------------------

function fmt(x: number): string {
	return Number.isFinite(x) ? x.toFixed(3) : 'n/a';
}
function fmtSummary(s: Summary): string {
	return `${fmt(s.mean)} [${fmt(s.lo)}, ${fmt(s.hi)}] (n=${s.n})`;
}

const md: string[] = [];
md.push(`# Retrieval Benchmark — ${label}`);
md.push('');
md.push(`Vault: \`${vaultId}\` · Dosyalar: ${files.map((f) => `\`${f}\``).join(', ')}`);
md.push(`Git SHA: \`${report.gitSha ?? 'yok'}\` · Dataset SHA1: \`${report.datasetSha1}\``);
md.push(`Toplam soru: ${items.length} — sıralama metriklerinde kullanılabilir: ${eligibleForRanking.length}, unanswerable: ${unanswerableItems.length}, atlanan: ${skippedItems}, missing anchor: ${totalMissing}`);
md.push('');

md.push('## Chunk-level ablasyon tablosu');
md.push('');
md.push('| Pipeline | Recall@5 | Recall@10 | MRR@10 | nDCG@10 |');
md.push('|---|---|---|---|---|');
for (const r of variantReports) {
	md.push(`| ${r.variant} | ${fmtSummary(r.chunk.recall5)} | ${fmtSummary(r.chunk.recall10)} | ${fmtSummary(r.chunk.mrr10)} | ${fmtSummary(r.chunk.ndcg10)} |`);
}
md.push('');

md.push('## File-level ablasyon tablosu');
md.push('');
md.push('| Pipeline | Recall@5 | Recall@10 | MRR@10 | nDCG@10 |');
md.push('|---|---|---|---|---|');
for (const r of variantReports) {
	md.push(`| ${r.variant} | ${fmtSummary(r.file.recall5)} | ${fmtSummary(r.file.recall10)} | ${fmtSummary(r.file.mrr10)} | ${fmtSummary(r.file.ndcg10)} |`);
}
md.push('');

md.push('## Tam metrik tablosu (chunk-level)');
md.push('');
md.push(`| Pipeline | ${METRIC_KEYS.join(' | ')} |`);
md.push(`|---|${METRIC_KEYS.map(() => '---').join('|')}|`);
for (const r of variantReports) {
	md.push(`| ${r.variant} | ${METRIC_KEYS.map((k) => fmt(r.chunk[k].mean)).join(' | ')} |`);
}
md.push('');

md.push('## prod ile eşleştirilmiş rastgeleleştirme testi (chunk-level, Recall@5 / nDCG@10)');
md.push('');
md.push('| Pipeline | p(Recall@5) | p(nDCG@10) |');
md.push('|---|---|---|');
for (const r of variantReports) {
	if (!r.vsProd) {
		md.push(`| ${r.variant} | — | — |`);
	} else {
		md.push(`| ${r.variant} | ${fmt(r.vsProd.recall5_p)} | ${fmt(r.vsProd.ndcg10_p)} |`);
	}
}
md.push('');

md.push('## Geri çekilme (abstention)');
md.push('');
md.push('| Pipeline | unanswerable boş oranı (iyi) | answerable yanlış-boş oranı (kötü) |');
md.push('|---|---|---|');
for (const r of variantReports) {
	md.push(`| ${r.variant} | ${fmt(r.abstention.unanswerableEmptyRate)} | ${fmt(r.abstention.answerableFalseEmptyRate)} |`);
}
md.push('');

for (const [label2, keyer] of [
	['Tür (type)', (r: VariantReport) => r.byType] as const,
	['Dil (lang)', (r: VariantReport) => r.byLang] as const,
	['Alan (domain)', (r: VariantReport) => r.byDomain] as const
]) {
	md.push(`## Kırılım: ${label2}`);
	md.push('');
	const groups = new Set<string>();
	for (const r of variantReports) for (const g of Object.keys(keyer(r))) groups.add(g);
	for (const g of groups) {
		md.push(`### ${g}`);
		md.push('');
		md.push('| Pipeline | Recall@5 (chunk) | nDCG@10 (chunk) |');
		md.push('|---|---|---|');
		for (const r of variantReports) {
			const b = keyer(r)[g];
			if (!b) continue;
			md.push(`| ${r.variant} | ${fmtSummary(b.chunk.recall5)} | ${fmtSummary(b.chunk.ndcg10)} |`);
		}
		md.push('');
	}
}

if (thresholdSweep) {
	md.push('## Eşik taraması (vector-raw mesafeleri)');
	md.push('');
	md.push('| Eşik | unanswerable boş oranı | answerable yanlış-boş oranı | Recall@5 |');
	md.push('|---|---|---|---|');
	for (const row of thresholdSweep) {
		md.push(`| ${row.threshold.toFixed(2)} | ${fmt(row.unanswerableEmptyRate)} | ${fmt(row.answerableFalseEmptyRate)} | ${fmt(row.recall5)} |`);
	}
	md.push('');
}

const rerankRows = variantReports.filter((r) => r.rerankQuantiles);
if (rerankRows.length > 0) {
	md.push('## Reranker skor dağılımı (top-1), quantiles p10/p25/p50/p75/p90');
	md.push('');
	md.push('| Pipeline | answerable | unanswerable |');
	md.push('|---|---|---|');
	for (const r of rerankRows) {
		md.push(`| ${r.variant} | ${r.rerankQuantiles!.answerable.map(fmt).join(' / ')} | ${r.rerankQuantiles!.unanswerable.map(fmt).join(' / ')} |`);
	}
	md.push('');
}

md.push('## Gecikme (latency), ms — ilk sorgu hariç (warm), P50/P95');
md.push('');
md.push('| Pipeline | embedMs | knnMs | ftsMs | rerankMs | qxMs | totalMs |');
md.push('|---|---|---|---|---|---|---|');
for (const r of variantReports) {
	const cell = (f: (typeof TIMING_FIELDS)[number]) => {
		const w = r.latency.warm[f];
		return w ? `${fmt(w.p50)} / ${fmt(w.p95)}` : '—';
	};
	md.push(`| ${r.variant} | ${cell('embedMs')} | ${cell('knnMs')} | ${cell('ftsMs')} | ${cell('rerankMs')} | ${cell('qxMs')} | ${cell('totalMs')} |`);
}
md.push('');
md.push('### İlk sorgu (cold), ms');
md.push('');
md.push('| Pipeline | totalMs |');
md.push('|---|---|');
for (const r of variantReports) md.push(`| ${r.variant} | ${r.latency.cold.totalMs !== undefined ? fmt(r.latency.cold.totalMs) : '—'} |`);
md.push('');

if (rerankerStats) {
	md.push('## Reranker istatistikleri');
	md.push('');
	md.push(`Cihaz: ${rerankerStats.device}, dtype: ${rerankerStats.dtype}, revision: \`${rerankerStats.revision}\``);
	md.push(`Peak VRAM: ${fmt(rerankerStats.peak_vram_mb)} MB, RSS: ${fmt(rerankerStats.rss_mb)} MB, load: ${fmt(rerankerLoadMs)} ms`);
	md.push('');
}

md.push('## İzolasyon');
md.push('');
md.push(isolationOk ? 'chats.db / index.db / study.db çalıştırma boyunca değişmedi.' : '**UYARI: bir veya daha fazla dosya değişti — yukarıdaki isolation alanına bakın.**');
md.push('');

fs.writeFileSync(path.join(outDir, 'retrieval.md'), md.join('\n'), 'utf-8');

console.log(`\nÇıktı: ${outDir}`);
console.log(`  retrieval.json`);
console.log(`  retrieval.md`);
