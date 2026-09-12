import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { openDb, listKnownFiles, deleteFile, upsertFile, type FileRow } from './db';
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
				)
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
