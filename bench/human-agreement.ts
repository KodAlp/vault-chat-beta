/**
 * CLI: compares human ratings (downloaded from bench/human-eval.ts's page)
 * against the judge's own scores for the same items, reporting Spearman's
 * rho and quadratic-weighted Cohen's kappa for correctness and relevance —
 * the pure math lives in bench/lib/human-agreement.ts (tested there).
 *
 *   npx tsx bench/human-agreement.ts --ratings <human-ratings.json> --from <generation.json>
 */
import fs from 'node:fs';
import { computeAgreement } from './lib/human-agreement';

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i !== -1 ? argv[i + 1] : undefined;
}

const ratingsPath = argValue('--ratings');
const fromPath = argValue('--from');
if (!ratingsPath || !fromPath) {
	console.error('kullanım: npx tsx bench/human-agreement.ts --ratings <human-ratings.json> --from <generation.json>');
	process.exit(1);
}

interface RatingsFile {
	ratings: Record<string, { correctness?: number; relevance?: number; clarity?: number; citation_quality?: number }>;
}
interface GenerationItem {
	id: string;
	judgeFailed: boolean;
	judge?: { correctness: number; relevance: number };
}

const ratingsFile = JSON.parse(fs.readFileSync(ratingsPath, 'utf-8')) as RatingsFile;
const generation = JSON.parse(fs.readFileSync(fromPath, 'utf-8')) as { items: GenerationItem[] };
const byId = new Map(generation.items.map((i) => [i.id, i]));

const correctnessPairs: { human: number; judge: number }[] = [];
const relevancePairs: { human: number; judge: number }[] = [];

for (const [id, r] of Object.entries(ratingsFile.ratings)) {
	const item = byId.get(id);
	if (!item || item.judgeFailed || !item.judge) continue;
	if (typeof r.correctness === 'number') correctnessPairs.push({ human: r.correctness, judge: item.judge.correctness });
	if (typeof r.relevance === 'number') relevancePairs.push({ human: r.relevance, judge: item.judge.relevance });
}

const correctnessReport = computeAgreement(correctnessPairs);
const relevanceReport = computeAgreement(relevancePairs);

console.log(`Correctness: n=${correctnessReport.n}  Spearman ρ=${correctnessReport.spearman.toFixed(3)}  QWK=${correctnessReport.quadraticWeightedKappa.toFixed(3)}`);
console.log(`Relevance:   n=${relevanceReport.n}  Spearman ρ=${relevanceReport.spearman.toFixed(3)}  QWK=${relevanceReport.quadraticWeightedKappa.toFixed(3)}`);
