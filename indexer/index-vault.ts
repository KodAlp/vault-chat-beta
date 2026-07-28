import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { openDb, listKnownFiles, deleteFile, upsertFile, type FileRow } from './db';
import { chunkMarkdown } from './chunk';
import { embedDocuments } from './embed';
import { EXCLUDED_DIRS } from './excluded-dirs';

try {
	process.loadEnvFile();
} catch {
	// .env is optional; OLLAMA_URL/VAULT_PATH/INDEX_DB_PATH fall back to defaults below
}

const VAULT_PATH = path.resolve(process.cwd(), process.env.VAULT_PATH ?? '..');
const DB_PATH = path.resolve(
	process.cwd(),
	process.env.INDEX_DB_PATH ?? path.join('data', 'vault-index.db')
);

const args = process.argv.slice(2);
const isFull = args.includes('--full');
const isDryRun = args.includes('--dry-run');

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

	for (const absPath of walk(VAULT_PATH)) {
		const relPath = path.relative(VAULT_PATH, absPath).split(path.sep).join('/');
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
				depth: frontmatter.level ?? frontmatter.depth ?? '',
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
