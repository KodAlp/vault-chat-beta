import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import Database from 'better-sqlite3';
import { openDb, listKnownFiles, setPrerequisites, readIndexEmbedding, type FileRow, type IndexEmbeddingMeta } from './db';
import { buildSlugIndex, findCycles, parsePrerequisites, resolvePrerequisites } from './prerequisites';
import { hasKeywordIndex } from '../src/lib/server/keyword-search';
import { rebuildIndex } from './rebuild';
import { getEmbeddingConfig } from '../src/lib/server/providers/config-store';
import { resolveIndexerVault } from './paths';
import { walkMarkdownFiles as walk } from './walk-md';

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

	// Aşama 3b: the actual walk/hash/chunk/embed/upsert loop now lives in
	// rebuild.ts, shared with the app's own in-process reindex — this CLI's
	// console output is reconstructed from the returned stats so it reads
	// identically to before the extraction.
	const stats = await rebuildIndex(db, LIBRARY_ROOT, {
		dryRun: isDryRun,
		onInfo: (line) => console.log(line),
		onWarn: (line) => console.warn(line)
	});

	db?.close();

	const seconds = ((Date.now() - start) / 1000).toFixed(1);
	console.log('');
	console.log(isDryRun ? '(dry-run — hiçbir şey yazılmadı)' : 'İndeksleme tamamlandı.');
	console.log(
		`  indexed: ${stats.indexed}  skipped: ${stats.skipped}  yeniden bölünen: ${stats.resplit}  deleted: ${stats.deleted}  warnings: ${stats.warnings}`
	);
	console.log(`  süre: ${seconds}s`);
}

main().catch((err) => {
	console.error('İndeksleme başarısız:', err);
	process.exit(1);
});
