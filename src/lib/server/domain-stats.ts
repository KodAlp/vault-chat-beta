import type Database from 'better-sqlite3';

export interface DomainStat {
	domain: string;
	notes: number;
	/** Newest file mtime in the domain, ISO 8601 (the indexer stores epoch milliseconds). */
	lastUpdated: string | null;
}

export interface DomainStats {
	domains: DomainStat[];
	/** Indexed notes whose frontmatter names no domain. */
	noDomain: number;
	totalNotes: number;
}

/**
 * Per-domain note counts over the index's `files` table (list_domains MCP tool). A note with several
 * domains counts once under each; domains are grouped case-insensitively and shown in the spelling
 * seen first. Paths under `excludedPrefixes` (a vault's hiddenFolders) are skipped, as list_sources
 * does. Takes a connection so it runs against a temp DB in tests and imports nothing from SvelteKit.
 */
export function domainStats(db: Database.Database, excludedPrefixes: string[] = []): DomainStats {
	const rows = db.prepare('SELECT path, mtime, domains_json FROM files ORDER BY path').all() as {
		path: string;
		mtime: number;
		domains_json: string;
	}[];
	const byKey = new Map<string, { domain: string; notes: number; mtime: number }>();
	let noDomain = 0;
	let totalNotes = 0;
	for (const r of rows) {
		if (excludedPrefixes.some((p) => r.path === p || r.path.startsWith(`${p}/`))) continue;
		totalNotes++;
		let list: unknown;
		try {
			list = JSON.parse(r.domains_json);
		} catch {
			list = [];
		}
		const names = [...new Set((Array.isArray(list) ? list : []).filter((d): d is string => typeof d === 'string' && d.trim() !== ''))];
		if (names.length === 0) {
			noDomain++;
			continue;
		}
		const seen = new Set<string>();
		for (const name of names) {
			const key = name.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			const e = byKey.get(key) ?? { domain: name, notes: 0, mtime: 0 };
			e.notes++;
			e.mtime = Math.max(e.mtime, r.mtime);
			byKey.set(key, e);
		}
	}
	const domains = [...byKey.values()]
		.sort((a, b) => a.domain.localeCompare(b.domain))
		.map((e) => ({
			domain: e.domain,
			notes: e.notes,
			lastUpdated: e.mtime > 0 && Number.isFinite(e.mtime) ? new Date(e.mtime).toISOString() : null
		}));
	return { domains, noDomain, totalNotes };
}
