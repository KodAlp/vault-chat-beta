import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import Database from 'better-sqlite3';
import { openDb, listKnownFiles, deleteFile, upsertFile, setPrerequisites, readIndexEmbedding, type FileRow, type IndexEmbeddingMeta } from './db';
import { buildSlugIndex, findCycles, parsePrerequisites, resolvePrerequisites } from './prerequisites';
import { hasKeywordIndex } from '../src/lib/server/keyword-search';
import { chunkMarkdown, normalizeLevel, HARD_MAX_CHARS } from './chunk';
import { embedTexts } from '../src/lib/server/embeddings';
import { DOC_PREFIX } from '../src/lib/server/embed-config';
import { getEmbeddingConfig } from '../src/lib/server/providers/config-store';
import { resolveIndexerVault } from './paths';
import { walkMarkdownFiles as walk } from './walk-md';

/**
 * Aşama 3a (embedding-bagimsizligi): replaces indexer/embed.ts +
 * indexer/ollama-client.ts (both deleted) — the CLI now reads the same
 * providers.json embedding config the app does (config-store.ts, which uses
 * env.ts's process.env accessors, exactly like this CLI already does for
 * DATA_DIR/PROVIDERS_PATH — see env.ts's own doc comment) and calls the same
 * embeddings.ts module the app uses, instead of a second hand-rolled Ollama
 * client that only ever supported Ollama.
 */
async function embedDocuments(texts: string[]): Promise<number[][]> {
	return embedTexts(
		texts.map((t) => `${DOC_PREFIX}${t}`),
		{ purpose: 'document' }
	);
}

try {
	process.loadEnvFile();
} catch {
	// .env is optional; OLLAMA_URL/DATA_DIR fall back to defaults below
}

const args = process.argv.slice(2);
const isFull = args.includes('--full');
const isDryRun = args.includes('--dry-run');
const isFts = args.includes('--fts');
const isPrereqs = args.includes('--prereqs');

const vault = resolveIndexerVault(args);
const LIBRARY_ROOT = vault.libraryRoot;
const DB_PATH = vault.indexDbPath;

function sha256(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * True when a file's already-indexed chunks include one that HARD_MAX_CHARS
 * was supposed to rule out. The hash-based skip below is a genuine
 * optimization for unchanged files, but "unchanged" and "already correctly
 * chunked" are different claims: a chunk produced before Ö3/Ö4 (or before
 * chunk.ts existed at all) can be oversized forever, because nothing ever
 * re-chunks a file whose content hash hasn't moved. Measured on the real
 * index: yapay-zeka's Chollet note stayed one 1.449.838-char chunk across
 * repeated non-`--full` runs (E4) — a chunk that large reaches the model as
 * ~362k tokens and blows every cloud provider's context window.
 */
function hasOversizedChunk(db: Database.Database, relPath: string): boolean {
	const row = db
		.prepare('SELECT 1 FROM chunks WHERE path = ? AND length(display_text) > ? LIMIT 1')
		.get(relPath, HARD_MAX_CHARS);
	return row !== undefined;
}

async function main() {
	const start = Date.now();
	console.log(`vault: ${vault.name} (${vault.id})`);

	// `--fts`: only create/refresh the keyword index (chunks_fts) from the chunks
	// already stored. No file is read, nothing is re-embedded. This is how an index
	// that was built before the keyword fallback existed gets the table, since the
	// app opens the index read-only and cannot create it. See db.ts's ensureFts.
	if (isFts) {
		if (!fs.existsSync(DB_PATH)) {
			console.error(`Bu vault henüz indekslenmemiş: ${DB_PATH}`);
			process.exit(1);
		}
		const ftsDb = openDb(DB_PATH); // creates the table and syncs it with chunks
		const chunks = (ftsDb.prepare('SELECT count(*) AS c FROM chunks').get() as { c: number }).c;
		const rows = hasKeywordIndex(ftsDb)
			? (ftsDb.prepare('SELECT count(*) AS c FROM chunks_fts').get() as { c: number }).c
			: null;
		ftsDb.close();
		console.log(rows === null ? 'FTS5 bu SQLite derlemesinde yok; anahtar kelime yedeği kapalı.' : `chunks: ${chunks} | chunks_fts: ${rows}${chunks === rows ? ' (eşit)' : ' (UYUMSUZ)'}`);
		return;
	}

	// `--prereqs`: fill files.prerequisites_json for notes that are ALREADY indexed, from their
	// frontmatter alone. The normal pass skips a file whose sha256 is unchanged, so without this an index
	// built before F4 would only get the column for notes edited afterwards, and `--full` would delete
	// the database and re-embed every chunk for a few lines of metadata. Nothing is embedded or chunked.
	// With `--dry-run` the database is opened read-only: nothing is written, not even the new column.
	if (isPrereqs) {
		if (!fs.existsSync(DB_PATH)) {
			console.error(`Bu vault henüz indekslenmemiş: ${DB_PATH}`);
			process.exit(1);
		}
		const pdb = isDryRun ? new Database(DB_PATH, { readonly: true }) : openDb(DB_PATH); // openDb adds the column
		const knownFiles = listKnownFiles(pdb);
		const slugIndex = buildSlugIndex(knownFiles.keys());
		let withPrereqs = 0;
		let refs = 0;
		let changed = 0;
		let notIndexed = 0;
		const unresolved: string[] = [];
		const ambiguous: string[] = [];
		const graph = new Map<string, string[]>();
		for (const absPath of walk(LIBRARY_ROOT)) {
			const relPath = path.relative(LIBRARY_ROOT, absPath).split(path.sep).join('/');
			const row = knownFiles.get(relPath);
			if (!row) {
				notIndexed++;
				continue;
			}
			const names = parsePrerequisites(matter(fs.readFileSync(absPath, 'utf-8')).data.prerequisites);
			const json = JSON.stringify(names);
			const resolved = resolvePrerequisites(names, slugIndex);
			graph.set(relPath, resolved.resolved);
			if (names.length > 0) withPrereqs++;
			refs += names.length;
			for (const n of resolved.unresolved) unresolved.push(`${relPath} -> ${n}`);
			for (const n of resolved.ambiguous) ambiguous.push(`${relPath} -> ${n}`);
			// a database that predates the column has no value to compare with: everything counts as changed
			if ((row as Partial<FileRow>).prerequisites_json !== json) {
				changed++;
				if (!isDryRun) setPrerequisites(pdb, relPath, json);
			}
		}
		const cycles = findCycles(graph);
		pdb.close();
		console.log(isDryRun ? '(dry-run — hiçbir şey yazılmadı)' : 'Ön koşullar yazıldı.');
		console.log(`  indeksli dosya: ${knownFiles.size}  ön koşulu olan: ${withPrereqs}  referans: ${refs}  güncellenen: ${changed}  indekste olmayan .md: ${notIndexed}`);
		console.log(`  çözülemeyen: ${unresolved.length}  belirsiz (aynı ada birden çok dosya): ${ambiguous.length}  döngü: ${cycles.length}`);
		for (const u of unresolved.slice(0, 10)) console.log(`    çözülemedi: ${u}`);
		for (const a of ambiguous.slice(0, 10)) console.log(`    belirsiz: ${a}`);
		for (const c of cycles.slice(0, 5)) console.log(`    döngü: ${c.join(' -> ')}`);
		return;
	}

	if (isFull) {
		for (const suffix of ['', '-wal', '-shm']) {
			fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
		}
	}

	// Ö1: --dry-run claimed "hiçbir şey yazılmadı" but called openDb()
	// unconditionally, and openDb() runs CREATE TABLE IF NOT EXISTS, adds
	// columns and creates the vec0/FTS virtual tables as a side effect of
	// opening — real schema writes, dry-run or not. Measured on a copy: a
	// dry-run took a 12-table DB with no FTS and no prerequisites_json to an
	// 18-table DB with both. A dry-run only ever reads `known` below (the
	// write path is already gated by `!isDryRun`), so it needs a connection
	// at all only when the DB already exists, and never one that can migrate
	// anything — same pattern the --prereqs branch above already uses.
	const dbExistedBeforeThisRun = fs.existsSync(DB_PATH);
	const embeddingConfig = getEmbeddingConfig();
	const embeddingMeta: IndexEmbeddingMeta = {
		provider: embeddingConfig.providerId,
		model: embeddingConfig.model,
		dims: embeddingConfig.dims
	};
	const db = isDryRun
		? dbExistedBeforeThisRun
			? new Database(DB_PATH, { readonly: true })
			: null
		: openDb(DB_PATH, embeddingMeta);

	// Aşama 3a: after `--full` this is trivially true (openDb() just recorded
	// embeddingMeta into a brand-new index_meta). On a plain incremental run
	// against an EXISTING index built under a different config, refuse the
	// whole run up front rather than embedding some files under one vector
	// space and leaving others under another — the fix is `--full`, which
	// deletes and rebuilds the vec0 table at the new dimension.
	if (db && !isFull) {
		const existing = readIndexEmbedding(db);
		if (
			existing.provider !== embeddingMeta.provider ||
			existing.model !== embeddingMeta.model ||
			existing.dims !== embeddingMeta.dims
		) {
			console.error(
				`Bu vault "${existing.provider}/${existing.model}/${existing.dims}" ile indekslenmiş, ama ayarlanan embedding "${embeddingMeta.provider}/${embeddingMeta.model}/${embeddingMeta.dims}" — önce "npm run index -- --vault ${vault.id} --full" ile yeniden indeksle.`
			);
			db.close();
			process.exit(1);
		}
	}

	const known = db ? listKnownFiles(db) : new Map<string, FileRow>();
	const seen = new Set<string>();

	let indexed = 0;
	let skipped = 0;
	let warnings = 0;
	let resplit = 0;

	for (const absPath of walk(LIBRARY_ROOT)) {
		const relPath = path.relative(LIBRARY_ROOT, absPath).split(path.sep).join('/');
		const raw = fs.readFileSync(absPath, 'utf-8');
		const hash = sha256(raw);
		seen.add(relPath);

		const existing = known.get(relPath);
		if (existing && existing.sha256 === hash) {
			// E4: an unchanged hash normally means "skip", but not when this
			// file's existing chunks predate a chunker fix and are still
			// oversized — see hasOversizedChunk's doc comment. `db` is
			// guaranteed non-null here: `existing` can only be set from
			// `known`, and `known` is only ever populated when `db` was.
			if (!db || !hasOversizedChunk(db, relPath)) {
				skipped++;
				continue;
			}
			resplit++;
			console.log(`[yeniden bölünüyor] hash aynı, ama eski parça HARD_MAX_CHARS'ı aşıyor: ${relPath}`);
		}

		const { data } = matter(raw);
		if (!data.title && !data.topic) {
			console.warn(`[uyarı] frontmatter'da title/topic yok, atlandı: ${relPath}`);
			warnings++;
			continue;
		}

		const { frontmatter, chunks } = chunkMarkdown(raw);
		if (chunks.length === 0) {
			console.warn(`[uyarı] içerik boş, atlandı: ${relPath}`);
			warnings++;
			continue;
		}

		// Ö2: runs in both dry-run and real passes — previously this check only
		// existed implicitly, inside normalizeLevel(), inside the write-only
		// branch below. A non-string `level` (e.g. `level: 3`, valid YAML)
		// threw TypeError there and aborted the whole directory walk midway;
		// files alphabetically after the bad one were silently never indexed,
		// and --dry-run could not have caught it ahead of time because the
		// crashing call never ran during a dry run.
		const rawLevel = frontmatter.level ?? frontmatter.depth;
		if (rawLevel != null && typeof rawLevel !== 'string') {
			console.warn(
				`[uyarı] level/depth metin değil (${JSON.stringify(rawLevel)}), boş seviyeye düşürüldü: ${relPath}`
			);
			warnings++;
		}

		if (!isDryRun && db) {
			const embeddings = await embedDocuments(chunks.map((c) => c.embedText));
			const fileRow: FileRow = {
				path: relPath,
				sha256: hash,
				mtime: fs.statSync(absPath).mtimeMs,
				topic: frontmatter.title ?? frontmatter.topic ?? '',
				depth: normalizeLevel(frontmatter.level ?? frontmatter.depth ?? ''),
				domains_json: JSON.stringify(
					frontmatter.domains ?? (frontmatter.domain ? [frontmatter.domain] : [])
				),
				prerequisites_json: JSON.stringify(parsePrerequisites(frontmatter.prerequisites))
			};
			upsertFile(
				db,
				fileRow,
				chunks.map((c, i) => ({
					insert: { path: relPath, heading_path: c.headingPath, display_text: c.displayText },
					embedding: embeddings[i]
				}))
			);
		}
		indexed++;
	}

	let deletedCount = 0;
	for (const knownPath of known.keys()) {
		if (!seen.has(knownPath)) {
			if (!isDryRun && db) deleteFile(db, knownPath);
			deletedCount++;
		}
	}

	db?.close();

	const seconds = ((Date.now() - start) / 1000).toFixed(1);
	console.log('');
	console.log(isDryRun ? '(dry-run — hiçbir şey yazılmadı)' : 'İndeksleme tamamlandı.');
	console.log(
		`  indexed: ${indexed}  skipped: ${skipped}  yeniden bölünen: ${resplit}  deleted: ${deletedCount}  warnings: ${warnings}`
	);
	console.log(`  süre: ${seconds}s`);
}

main().catch((err) => {
	console.error('İndeksleme başarısız:', err);
	process.exit(1);
});
