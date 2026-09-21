import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import Database from 'better-sqlite3';
import { openDb, listKnownFiles, deleteFile, upsertFile, setPrerequisites, type FileRow } from './db';
import { buildSlugIndex, findCycles, parsePrerequisites, resolvePrerequisites } from './prerequisites';
import { hasKeywordIndex } from '../src/lib/server/keyword-search';
import { chunkMarkdown, normalizeLevel } from './chunk';
import { embedDocuments } from './embed';
import { EXCLUDED_DIRS } from './excluded-dirs';
import { resolveIndexerVault } from './paths';

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

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (EXCLUDED_DIRS.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
	}
	return out;
}

function sha256(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
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

	const db = openDb(DB_PATH);
	const known = listKnownFiles(db);
	const seen = new Set<string>();

	let indexed = 0;
	let skipped = 0;
	let warnings = 0;

	for (const absPath of walk(LIBRARY_ROOT)) {
		const relPath = path.relative(LIBRARY_ROOT, absPath).split(path.sep).join('/');
		const raw = fs.readFileSync(absPath, 'utf-8');
		const hash = sha256(raw);
		seen.add(relPath);

		const existing = known.get(relPath);
		if (existing && existing.sha256 === hash) {
			skipped++;
			continue;
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

		if (!isDryRun) {
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
			if (!isDryRun) deleteFile(db, knownPath);
			deletedCount++;
		}
	}

	db.close();

	const seconds = ((Date.now() - start) / 1000).toFixed(1);
	console.log('');
	console.log(isDryRun ? '(dry-run — hiçbir şey yazılmadı)' : 'İndeksleme tamamlandı.');
	console.log(
		`  indexed: ${indexed}  skipped: ${skipped}  deleted: ${deletedCount}  warnings: ${warnings}`
	);
	console.log(`  süre: ${seconds}s`);
}

main().catch((err) => {
	console.error('İndeksleme başarısız:', err);
	process.exit(1);
});
