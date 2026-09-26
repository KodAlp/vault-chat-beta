import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { embed } from '../../src/lib/server/ollama';

/**
 * Disk-backed cache in front of the production embed() (src/lib/server/ollama.ts),
 * called the same way retrieve.ts calls it (cpuOnly: true — see ollama.ts's doc
 * comment on why query embedding stays off the GPU). A benchmark run re-embeds
 * the same questions across several pipeline variants (vector-raw, hybrid,
 * hybrid+rerank, ...), so caching avoids paying Ollama's round-trip more than
 * once per (model, text) pair across a whole run — and across runs, since the
 * cache is a plain JSON file under data/vaults/default/bench/cache/.
 *
 * Free of `$lib`/`$env` imports (only node:fs/path/crypto plus the one
 * production import) so `bench/` runs under plain `tsx`.
 */

export interface EmbedCacheResult {
	vector: number[];
	ms: number;
	cached: boolean;
}

const DEFAULT_CACHE_PATH = path.join('data', 'vaults', 'default', 'bench', 'cache', 'embeddings.json');

function cacheKey(model: string, text: string): string {
	return createHash('sha1').update(model + '\u0000' + text).digest('hex');
}

export class EmbedCache {
	private cache: Record<string, number[]> = {};
	private readonly cachePath: string;
	private dirty = false;

	constructor(cachePath: string = DEFAULT_CACHE_PATH) {
		this.cachePath = cachePath;
		this.load();
	}

	private load(): void {
		try {
			const raw = fs.readFileSync(this.cachePath, 'utf-8');
			this.cache = JSON.parse(raw) as Record<string, number[]>;
		} catch {
			this.cache = {};
		}
	}

	/** Called after every new entry — a benchmark run's cache is small (a few
	 * hundred distinct texts at most) so writing the whole file each time is
	 * cheap, and it means a crash mid-run never loses embeddings already paid for. */
	private persist(): void {
		fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
		fs.writeFileSync(this.cachePath, JSON.stringify(this.cache), 'utf-8');
		this.dirty = false;
	}

	async embedCached(text: string, model: string): Promise<EmbedCacheResult> {
		const key = cacheKey(model, text);
		const hit = this.cache[key];
		if (hit) return { vector: hit, ms: 0, cached: true };

		const t0 = Date.now();
		const [vector] = await embed([text], model, { cpuOnly: true });
		const ms = Date.now() - t0;
		this.cache[key] = vector;
		this.dirty = true;
		this.persist();
		return { vector, ms, cached: false };
	}

	/** No-op unless a caller batched writes some other way — persist() already
	 * runs after every miss, but exposed for symmetry/explicitness at call sites. */
	flush(): void {
		if (this.dirty) this.persist();
	}

	size(): number {
		return Object.keys(this.cache).length;
	}
}
