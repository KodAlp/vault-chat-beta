// Stratified chunk sampler for the RAG benchmark's golden-set "batch" files.
// LLM agents read a batch file and turn its seeds into golden.jsonl lines
// (see validate-golden.ts for the schema those lines must satisfy).
//
//   npx tsx bench/dataset/sample-chunks.ts --vault default --batches 2 --per-batch 30 --seed 7 [--out <dir>]
//
// Opens index.db strictly read-only ({readonly: true, fileMustExist: true})
// and never writes to it or to any other app data file — the only writes
// this script makes are the batch-XX.json files under --out (default
// `<vault.dir>/bench/work/`).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { resolveVault } from '../../src/lib/server/vaults';
import { getLibrarySettings } from '../../src/lib/server/library-read';
import { chunkAnchor } from '../lib/anchor';

// --- CLI args ---------------------------------------------------------------

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i !== -1 ? argv[i + 1] : undefined;
}

const vaultId = argValue('--vault') ?? 'default';
const batchCount = Number(argValue('--batches') ?? '1');
const perBatch = Number(argValue('--per-batch') ?? '30');
const seed = Number(argValue('--seed') ?? '1');
const outDirArg = argValue('--out');

if (!Number.isInteger(batchCount) || batchCount < 1) {
	console.error(`--batches geçersiz: ${argValue('--batches')}`);
	process.exit(1);
}
if (!Number.isInteger(perBatch) || perBatch < 1) {
	console.error(`--per-batch geçersiz: ${argValue('--per-batch')}`);
	process.exit(1);
}

// --- seeded PRNG (mulberry32, public domain) --------------------------------
// Same tiny generator as bench/lib/metrics.ts's private mulberry32 —
// reimplemented here rather than imported since that one isn't exported
// (metrics.ts only needs it internally for bootstrap/randomization tests).
// Kept seedable so a batch file is exactly reproducible given --seed.
function mulberry32(seedValue: number): () => number {
	let a = seedValue >>> 0;
	return function (): number {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function seededShuffle<T>(arr: T[], rand: () => number): T[] {
	const out = arr.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Largest-remainder proportional allocation: splits `total` across the
 * buckets in `sizes` proportional to each bucket's size, summing to exactly
 * `total` (ordinary rounding can over/undershoot by a few). Deterministic
 * given a stable iteration order (Map preserves insertion order; callers
 * insert in a sorted key order). */
function allocateProportional(sizes: Map<string, number>, total: number): Map<string, number> {
	const grandTotal = [...sizes.values()].reduce((a, b) => a + b, 0);
	const result = new Map<string, number>();
	if (grandTotal === 0 || total === 0) {
		for (const key of sizes.keys()) result.set(key, 0);
		return result;
	}
	const remainders: { key: string; remainder: number }[] = [];
	let assigned = 0;
	for (const [key, size] of sizes) {
		const exact = (size / grandTotal) * total;
		const floor = Math.floor(exact);
		result.set(key, floor);
		assigned += floor;
		remainders.push({ key, remainder: exact - floor });
	}
	remainders.sort((a, b) => b.remainder - a.remainder);
	let leftover = total - assigned;
	for (let i = 0; leftover > 0 && i < remainders.length; i++, leftover--) {
		result.set(remainders[i].key, (result.get(remainders[i].key) ?? 0) + 1);
	}
	return result;
}

// --- domain candidates for "topics absent from this vault" -----------------
// Deliberately varied across CS subfields so unanswerable seeds aren't all
// networking or all crypto. Extend freely — anything genuinely absent (0 FTS
// hits) is fair game; ones that turn out to exist are reported, not silently
// dropped, so a reviewer can see why the candidate list shrank.
const UNANSWERABLE_CANDIDATES = [
	'quantum error correction',
	'kubernetes operator',
	'webassembly gc',
	'bluetooth low energy pairing',
	'tcp bbr',
	'kubernetes',
	'raft consensus',
	'paxos',
	'zero knowledge proof',
	'homomorphic encryption',
	'differential privacy',
	'byzantine fault tolerance',
	'consistent hashing',
	'bloom filter',
	'gpu ray tracing',
	'quantum computing',
	'blockchain smart contract',
	'oauth pkce flow',
	'grpc protocol buffers',
	'webrtc ice candidate',
	'css flexbox grid',
	'graphql schema',
	'react hooks',
	'docker container'
];
const DOMAINS_NOT_IN_VAULT_TARGET = 8;

/** AND-of-terms FTS5 match over chunks_fts's default (all-column) search —
 * "does this topic show up anywhere at all", not a precise phrase match.
 * That looseness is intentional and documented at the call site: it can
 * over-reject (flag a topic as present because two common words happen to
 * co-occur), never under-reject, which is the safe direction for seeding
 * unanswerable questions — a false "exists" costs a candidate, a false
 * "absent" would corrupt the golden set with a question the vault can
 * actually answer. */
function ftsHitCount(db: Database.Database, phrase: string): number {
	const q = phrase
		.trim()
		.split(/\s+/)
		.map((w) => `"${w.replace(/"/g, '')}"`)
		.join(' AND ');
	const row = db.prepare(`SELECT count(*) AS c FROM chunks_fts WHERE chunks_fts MATCH ?`).get(q) as { c: number };
	return row.c;
}

// --- types matching the spec's batch-file schema ----------------------------

interface Seed {
	anchor: string;
	path: string;
	topic: string;
	heading_path: string;
	depth: string;
	domains: string[];
	text: string;
}

interface PairSeed {
	a: Seed;
	b: Seed;
	distance: number;
}

interface BatchFile {
	vault: string;
	seed: number;
	generatedAt: string;
	single: Seed[];
	pairs: PairSeed[];
	domainsNotInVault: string[];
}

interface EligibleRow {
	id: number;
	path: string;
	heading_path: string;
	display_text: string;
	topic: string;
	depth: string;
	domain: string;
	domains: string[];
}

const MIN_CHUNK_LEN = 300;
const PAIR_DISTANCE_MIN = 0.2;
const PAIR_DISTANCE_MAX = 0.5;
const PAIR_KNN_OVERFETCH = 40;
const PAIR_SHARE = 0.4;

function toSeed(row: EligibleRow): Seed {
	return {
		anchor: chunkAnchor({ path: row.path, heading_path: row.heading_path, display_text: row.display_text }),
		path: row.path,
		topic: row.topic,
		heading_path: row.heading_path,
		depth: row.depth,
		domains: row.domains,
		text: row.display_text
	};
}

async function main() {
	const vault = resolveVault(vaultId);
	if (!fs.existsSync(vault.indexDbPath)) {
		console.error(`index.db yok: ${vault.indexDbPath} — önce \`npm run index -- --vault ${vaultId}\` çalıştır.`);
		process.exit(1);
	}
	const outDir = outDirArg ?? path.join(vault.dir, 'bench', 'work');
	fs.mkdirSync(outDir, { recursive: true });

	const db = new Database(vault.indexDbPath, { readonly: true, fileMustExist: true });
	sqliteVec.load(db);

	const hiddenFolders = getLibrarySettings(vault).hiddenFolders;
	const isHidden = (p: string) => hiddenFolders.some((h: string) => p === h || p.startsWith(`${h}/`));

	const allRows = db
		.prepare(
			`SELECT c.id, c.path, c.heading_path, c.display_text, f.topic, f.depth, f.domains_json
			 FROM chunks c JOIN files f ON f.path = c.path`
		)
		.all() as { id: number; path: string; heading_path: string; display_text: string; topic: string; depth: string; domains_json: string }[];

	// Full id -> row map (for KNN neighbor lookups, which must resolve any
	// chunk id, not just eligible ones, before the eligibility filter decides
	// whether that neighbor is usable as pair partner B).
	const byId = new Map<number, EligibleRow>();
	for (const r of allRows) {
		const domains = JSON.parse(r.domains_json) as string[];
		byId.set(r.id, {
			id: r.id,
			path: r.path,
			heading_path: r.heading_path,
			display_text: r.display_text,
			topic: r.topic,
			depth: r.depth || 'unspecified',
			domain: domains[0] ?? 'genel',
			domains
		});
	}

	function isEligible(row: EligibleRow): boolean {
		return !isHidden(row.path) && row.display_text.length >= MIN_CHUNK_LEN;
	}

	const eligible = [...byId.values()].filter(isEligible);
	console.log(`[sample-chunks] toplam chunk: ${allRows.length}, uygun (görünür + >=${MIN_CHUNK_LEN} karakter): ${eligible.length}`);

	// Bucket key: `${domain}::${depth}` — stratify singles/pairs proportional
	// to how much of the eligible pool each (domain, depth) combination is.
	const bucketOf = (row: EligibleRow) => `${row.domain}::${row.depth}`;
	const buckets = new Map<string, EligibleRow[]>();
	for (const row of eligible) {
		const key = bucketOf(row);
		const list = buckets.get(key);
		if (list) list.push(row);
		else buckets.set(key, [row]);
	}
	const sortedBucketKeys = [...buckets.keys()].sort();
	const bucketSizes = new Map(sortedBucketKeys.map((k) => [k, buckets.get(k)!.length]));

	// --- domainsNotInVault (computed once, shared across batches — it does
	// not depend on the per-batch seed, only on the vault's own content). ---
	const acceptedTopics: string[] = [];
	const rejectedTopics: { topic: string; hits: number }[] = [];
	for (const candidate of UNANSWERABLE_CANDIDATES) {
		let hits = 0;
		try {
			hits = ftsHitCount(db, candidate);
		} catch (err) {
			console.warn(`[sample-chunks] FTS sorgusu başarısız oldu (chunks_fts yok mu?): ${err instanceof Error ? err.message : err}`);
			break;
		}
		if (hits === 0) acceptedTopics.push(candidate);
		else rejectedTopics.push({ topic: candidate, hits });
		if (acceptedTopics.length >= DOMAINS_NOT_IN_VAULT_TARGET) break;
	}
	console.log(`\n[sample-chunks] domainsNotInVault adayları:`);
	console.log(`  kabul edilen (${acceptedTopics.length}): ${acceptedTopics.join(', ') || '(yok)'}`);
	if (rejectedTopics.length > 0) {
		console.log(`  reddedilen (vault'ta zaten var):`);
		for (const r of rejectedTopics) console.log(`    - "${r.topic}" (${r.hits} FTS isabeti)`);
	}

	for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
		// Independent-but-reproducible per-batch stream: batch N can be
		// regenerated alone with the same --seed and still match byte-for-byte.
		const batchSeed = seed + batchIndex * 1_000_003;
		const rand = mulberry32(batchSeed);

		const numPairs = Math.round(perBatch * PAIR_SHARE);
		const numSingles = perBatch - numPairs;

		const usedFilesForSingles = new Set<string>();
		const usedChunkIds = new Set<number>();
		const singles: EligibleRow[] = [];

		// Pass 1: proportional per-bucket allocation, at most one chunk per
		// file (the spec's "single" constraint).
		const singleTargets = allocateProportional(bucketSizes, numSingles);
		for (const key of sortedBucketKeys) {
			const target = singleTargets.get(key) ?? 0;
			if (target === 0) continue;
			const shuffled = seededShuffle(buckets.get(key)!, rand);
			let picked = 0;
			for (const row of shuffled) {
				if (picked >= target) break;
				if (usedFilesForSingles.has(row.path)) continue;
				singles.push(row);
				usedFilesForSingles.add(row.path);
				usedChunkIds.add(row.id);
				picked++;
			}
		}
		// Pass 2: fill any shortfall (a thin bucket ran out of distinct files)
		// from the whole remaining pool, still respecting one-per-file.
		if (singles.length < numSingles) {
			const remaining = seededShuffle(
				eligible.filter((r) => !usedFilesForSingles.has(r.path)),
				rand
			);
			for (const row of remaining) {
				if (singles.length >= numSingles) break;
				singles.push(row);
				usedFilesForSingles.add(row.path);
				usedChunkIds.add(row.id);
			}
		}
		if (singles.length < numSingles) {
			console.warn(`[sample-chunks] batch ${batchIndex + 1}: sadece ${singles.length}/${numSingles} tekil örnek bulunabildi (dosya çeşitliliği tükendi).`);
		}

		// --- pairs -------------------------------------------------------
		const pairTargets = allocateProportional(bucketSizes, numPairs);
		const pairs: { a: EligibleRow; b: EligibleRow; distance: number }[] = [];

		function tryFindPartner(a: EligibleRow): { b: EligibleRow; distance: number } | null {
			const vecRow = db.prepare(`SELECT embedding FROM vec_chunks WHERE chunk_id = ?`).get(BigInt(a.id)) as { embedding: Buffer } | undefined;
			if (!vecRow) return null;
			const neighbors = db
				.prepare(`SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
				.all(vecRow.embedding, PAIR_KNN_OVERFETCH) as { chunk_id: number; distance: number }[];
			for (const n of neighbors) {
				if (n.chunk_id === a.id) continue;
				if (n.distance < PAIR_DISTANCE_MIN || n.distance > PAIR_DISTANCE_MAX) continue;
				if (usedChunkIds.has(n.chunk_id)) continue;
				const candidate = byId.get(n.chunk_id);
				if (!candidate) continue;
				if (candidate.path === a.path) continue; // must be a different file
				if (!isEligible(candidate)) continue;
				return { b: candidate, distance: n.distance };
			}
			return null;
		}

		for (const key of sortedBucketKeys) {
			const target = pairTargets.get(key) ?? 0;
			if (target === 0) continue;
			const shuffled = seededShuffle(buckets.get(key)!, rand);
			let picked = 0;
			for (const a of shuffled) {
				if (picked >= target) break;
				if (usedChunkIds.has(a.id)) continue;
				const partner = tryFindPartner(a);
				if (!partner) continue;
				pairs.push({ a, b: partner.b, distance: partner.distance });
				usedChunkIds.add(a.id);
				usedChunkIds.add(partner.b.id);
				picked++;
			}
		}
		if (pairs.length < numPairs) {
			// Fill shortfall from the whole remaining eligible pool.
			const remaining = seededShuffle(
				eligible.filter((r) => !usedChunkIds.has(r.id)),
				rand
			);
			for (const a of remaining) {
				if (pairs.length >= numPairs) break;
				const partner = tryFindPartner(a);
				if (!partner) continue;
				pairs.push({ a, b: partner.b, distance: partner.distance });
				usedChunkIds.add(a.id);
				usedChunkIds.add(partner.b.id);
			}
		}
		if (pairs.length < numPairs) {
			console.warn(`[sample-chunks] batch ${batchIndex + 1}: sadece ${pairs.length}/${numPairs} çift bulunabildi (cosine [${PAIR_DISTANCE_MIN}, ${PAIR_DISTANCE_MAX}] aralığında komşu yetersiz).`);
		}

		const batch: BatchFile = {
			vault: vaultId,
			seed: batchSeed,
			generatedAt: new Date().toISOString(),
			single: singles.map(toSeed),
			pairs: pairs.map((p) => ({ a: toSeed(p.a), b: toSeed(p.b), distance: p.distance })),
			domainsNotInVault: acceptedTopics
		};

		const fileName = `batch-${String(batchIndex + 1).padStart(2, '0')}.json`;
		const outPath = path.join(outDir, fileName);
		fs.writeFileSync(outPath, JSON.stringify(batch, null, 2) + '\n', 'utf-8');

		// --- summary -------------------------------------------------------
		console.log(`\n[sample-chunks] ${fileName} yazıldı: ${singles.length} tekil, ${pairs.length} çift (seed=${batchSeed})`);
		const domainCounts: Record<string, number> = {};
		const depthCounts: Record<string, number> = {};
		const allPicked = [...singles, ...pairs.flatMap((p) => [p.a, p.b])];
		for (const row of allPicked) {
			domainCounts[row.domain] = (domainCounts[row.domain] ?? 0) + 1;
			depthCounts[row.depth] = (depthCounts[row.depth] ?? 0) + 1;
		}
		console.log(`  domain dağılımı: ${JSON.stringify(domainCounts)}`);
		console.log(`  depth dağılımı: ${JSON.stringify(depthCounts)}`);
	}

	db.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
