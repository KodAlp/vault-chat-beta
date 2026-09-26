// Validates a hand-labeled golden question set (JSONL) against its schema
// and against a vault's live index — anchors must still resolve, domain/type/
// difficulty/lang distributions are reported against a target profile, and a
// leakage check flags questions that copy their source chunk almost verbatim.
//
//   npx tsx bench/dataset/validate-golden.ts --vault default --file <golden.jsonl> [--targets pilot|full]
//
// Opens index.db strictly read-only ({readonly: true, fileMustExist: true})
// and never writes to it or to any other app data file. Exits 1 if any
// error-level problem was found (warnings never affect the exit code).
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { resolveVault } from '../../src/lib/server/vaults';
import { buildAnchorIndex, resolveQrels, type QrelLabel } from '../lib/anchor';
import {
	checkAnswerabilityRules,
	checkMultiSpanRule,
	compareToTargets,
	computeDistribution,
	computeDomainDistribution,
	findDuplicateQuestions,
	FULL_TARGET,
	parseGoldenLine,
	PILOT_TARGET,
	questionChunkOverlap,
	tokenize,
	type GoldenLine,
	type TargetProfile
} from './golden';

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i !== -1 ? argv[i + 1] : undefined;
}

const vaultId = argValue('--vault') ?? 'default';
const filePath = argValue('--file');
const targetsArg = argValue('--targets');

if (!filePath) {
	console.error('--file <golden.jsonl> gerekli');
	process.exit(1);
}
let target: TargetProfile | undefined;
if (targetsArg === 'pilot') target = PILOT_TARGET;
else if (targetsArg === 'full') target = FULL_TARGET;
else if (targetsArg !== undefined) {
	console.error(`--targets geçersiz: ${targetsArg} (pilot|full olmalı)`);
	process.exit(1);
}

if (!fs.existsSync(filePath)) {
	console.error(`dosya yok: ${filePath}`);
	process.exit(1);
}

const vault = resolveVault(vaultId);
if (!fs.existsSync(vault.indexDbPath)) {
	console.error(`index.db yok: ${vault.indexDbPath}`);
	process.exit(1);
}

const errors: string[] = [];
const warnings: string[] = [];

// --- parse + per-line schema/rule checks ------------------------------------

const raw = fs.readFileSync(filePath, 'utf-8');
const rawLines = raw.split('\n').filter((l) => l.trim().length > 0);
console.log(`[validate-golden] ${filePath}: ${rawLines.length} satır`);

const lines: GoldenLine[] = [];
for (let i = 0; i < rawLines.length; i++) {
	const { line, errors: lineErrors } = parseGoldenLine(rawLines[i], i + 1);
	if (lineErrors.length > 0) {
		errors.push(...lineErrors);
		continue;
	}
	lines.push(line!);
}

// unique ids
const idCounts = new Map<string, number>();
for (const l of lines) idCounts.set(l.id, (idCounts.get(l.id) ?? 0) + 1);
for (const [id, count] of idCounts) {
	if (count > 1) errors.push(`id '${id}' ${count} kez tekrarlanıyor`);
}

// answerability / multi-span rules
for (const l of lines) {
	errors.push(...checkAnswerabilityRules(l));
	warnings.push(...checkMultiSpanRule(l));
}

// duplicate / near-duplicate questions
const dupPairs = findDuplicateQuestions(lines, 0.8);
for (const d of dupPairs) {
	const label = d.exact ? 'tam aynı (normalize edilmiş metin)' : `yakın kopya (Jaccard=${d.jaccard.toFixed(2)})`;
	warnings.push(`soru ${d.a} ve ${d.b}: ${label}`);
}

// --- resolve anchors against the live index ---------------------------------

const db = new Database(vault.indexDbPath, { readonly: true, fileMustExist: true });
const anchorIndex = buildAnchorIndex(db);

let exactCount = 0;
let fileOnlyCount = 0;
let missingCount = 0;
for (const l of lines) {
	for (const r of l.relevant) {
		const [resolved] = resolveQrels([{ anchor: r.anchor, path: r.path, grade: r.grade } satisfies QrelLabel], anchorIndex);
		if (resolved.status === 'exact') {
			exactCount++;
			// Sanity check: an anchor is content-addressed off (path, heading_path,
			// text), so an 'exact' match should never disagree with the label's own
			// path/heading_path unless the golden file was hand-edited incorrectly
			// (copy-pasted the wrong path next to a correct anchor, or vice versa).
			const ids = anchorIndex.byAnchor.get(r.anchor) ?? [];
			const meta = ids.length > 0 ? anchorIndex.byId.get(ids[0]) : undefined;
			if (meta && (meta.path !== r.path || meta.heading_path !== r.heading_path)) {
				errors.push(
					`id=${l.id}: relevant anchor ${r.anchor} indekste path/heading_path olarak "${meta.path}" / "${meta.heading_path}" gösteriyor, golden satırında "${r.path}" / "${r.heading_path}" yazıyor`
				);
			}
		} else if (resolved.status === 'file-only') {
			fileOnlyCount++;
			warnings.push(`id=${l.id}: relevant anchor ${r.anchor} artık indekste yok ama dosya (${r.path}) hâlâ var — not muhtemelen düzenlenmiş`);
		} else {
			missingCount++;
			errors.push(`id=${l.id}: relevant anchor ${r.anchor} (${r.path}) indekste bulunamadı — dosya silinmiş/yeniden adlandırılmış olabilir`);
		}
	}
}
console.log(`\n[validate-golden] anchor çözümleme: exact=${exactCount} file-only=${fileOnlyCount} missing=${missingCount}`);

// --- distributions -----------------------------------------------------------

const dist = computeDistribution(lines);
console.log(`\n[validate-golden] dağılım (toplam ${dist.total}):`);
console.log(`  type: ${JSON.stringify(dist.byType)}`);
console.log(`  lang: ${JSON.stringify(dist.byLang)}`);
console.log(`  difficulty: ${JSON.stringify(dist.byDifficulty)}`);

const fileRows = db.prepare('SELECT path, domains_json FROM files').all() as { path: string; domains_json: string }[];
const pathToDomains = new Map(fileRows.map((r) => [r.path, JSON.parse(r.domains_json) as string[]]));
const domainDist = computeDomainDistribution(lines, pathToDomains);
console.log(`  domain: ${JSON.stringify(domainDist)}`);

if (target) {
	const deviations = compareToTargets(dist, target);
	if (deviations.length > 0) {
		console.log(`\n[validate-golden] hedef karşılaştırma (${target.name}) sapmaları:`);
		for (const d of deviations) console.log(`  - ${d}`);
		warnings.push(...deviations);
	} else {
		console.log(`\n[validate-golden] hedef karşılaştırma (${target.name}): sapma yok`);
	}
}

// --- leakage / overlap check -------------------------------------------------

const chunkTextById = new Map<number, string>();
for (const row of db.prepare('SELECT id, display_text FROM chunks').all() as { id: number; display_text: string }[]) {
	chunkTextById.set(row.id, row.display_text);
}

interface OverlapEntry {
	id: string;
	overlap: number;
}
const overlaps: OverlapEntry[] = [];
for (const l of lines) {
	if (!l.answerable) continue;
	const qTokens = tokenize(l.question);
	let maxOverlap = 0;
	let any = false;
	for (const r of l.relevant) {
		const ids = anchorIndex.byAnchor.get(r.anchor) ?? [];
		if (ids.length === 0) continue; // not resolvable ('file-only'/'missing') — no live text to compare against
		const text = chunkTextById.get(ids[0]);
		if (text === undefined) continue;
		const overlap = questionChunkOverlap(qTokens, new Set(tokenize(text)));
		if (overlap > maxOverlap) maxOverlap = overlap;
		any = true;
	}
	if (any) overlaps.push({ id: l.id, overlap: maxOverlap });
}
if (overlaps.length > 0) {
	const meanOverlap = overlaps.reduce((s, o) => s + o.overlap, 0) / overlaps.length;
	console.log(`\n[validate-golden] soru/chunk kelime örtüşmesi (leakage): ortalama=${meanOverlap.toFixed(3)}, n=${overlaps.length}`);
	const top10 = [...overlaps].sort((a, b) => b.overlap - a.overlap).slice(0, 10);
	console.log('  en yüksek örtüşen 10 soru:');
	for (const o of top10) {
		const flag = o.overlap > 0.7 ? '  <-- >0.7, muhtemelen notu birebir kopyalıyor' : '';
		console.log(`    ${o.id}: ${o.overlap.toFixed(3)}${flag}`);
		if (o.overlap > 0.7) warnings.push(`id=${o.id}: soru/chunk örtüşmesi ${o.overlap.toFixed(3)} (>0.7) — soru notu neredeyse birebir kopyalıyor`);
	}
}

db.close();

// --- final report --------------------------------------------------------

console.log(`\n[validate-golden] ${errors.length} hata, ${warnings.length} uyarı`);
if (warnings.length > 0) {
	console.log('\nUyarılar:');
	for (const w of warnings) console.log(`  - ${w}`);
}
if (errors.length > 0) {
	console.log('\nHatalar:');
	for (const e of errors) console.log(`  - ${e}`);
	process.exit(1);
}
process.exit(0);
