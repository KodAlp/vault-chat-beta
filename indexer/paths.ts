import path from 'node:path';

/**
 * LIBRARY_PATH is the new, primary root (source-ingest skill's data/library/
 * migration); VAULT_PATH is kept as a deprecated alias so existing .env files
 * (VAULT_PATH=..) keep indexing exactly what they always did, unchanged. Only
 * a fresh install with neither var set gets the new default.
 */
export function resolveLibraryRoot(): string {
	const raw = process.env.LIBRARY_PATH;
	if (raw) return path.resolve(process.cwd(), raw);

	const legacy = process.env.VAULT_PATH;
	if (legacy) {
		console.warn('[uyarı] VAULT_PATH kullanımdan kaldırıldı, bunun yerine LIBRARY_PATH kullan.');
		return path.resolve(process.cwd(), legacy);
	}

	return path.resolve(process.cwd(), 'data', 'library');
}
