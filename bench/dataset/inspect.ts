/**
 * Read-only lookup helper for whoever writes golden-set questions:
 *
 *   npx tsx bench/dataset/inspect.ts chunks --vault default --path wiki/os/paging.md
 *     every chunk of one note, in order, with its anchor (for multi-chunk / long_context labels)
 *   npx tsx bench/dataset/inspect.ts search --vault default --q "bloom filter"
 *     FTS5 OR search, top hits with anchors (to find a second relevant chunk, or to confirm that
 *     an "unanswerable" topic really is absent — zero hits for its key terms)
 *
 * Opens index.db read-only; never writes.
 */
import process from 'node:process';
import Database from 'better-sqlite3';
import { resolveVault } from '../../src/lib/server/vaults';
import { chunkAnchor } from '../lib/anchor';

const argv = process.argv.slice(2);
const value = (name: string) => {
	const i = argv.indexOf(name);
	return i !== -1 ? argv[i + 1] : undefined;
};

interface Row {
	path: string;
	heading_path: string;
	display_text: string;
}

function main() {
	const cmd = argv[0];
	const v = resolveVault(value('--vault') ?? 'default');
	const db = new Database(v.indexDbPath, { readonly: true, fileMustExist: true });
	try {
		if (cmd === 'chunks') {
			const p = value('--path');
			if (!p) throw new Error('--path gerekli');
			const rows = db.prepare('SELECT path, heading_path, display_text FROM chunks WHERE path = ? ORDER BY id').all(p) as Row[];
			if (rows.length === 0) console.log(`(indekste parça yok: ${p})`);
			for (const r of rows) {
				console.log(`=== ${chunkAnchor(r)} | ${r.heading_path}`);
				console.log(r.display_text);
				console.log();
			}
		} else if (cmd === 'search') {
			const q = value('--q');
			if (!q) throw new Error('--q gerekli');
			const limit = Number(value('--limit') ?? 10);
			const terms = q
				.split(/\s+/)
				.map((t) => t.replace(/"/g, ''))
				.filter(Boolean)
				.map((t) => `"${t}"`);
			const rows = db
				.prepare(
					`SELECT c.path, c.heading_path, c.display_text FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
					 WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`
				)
				.all(terms.join(' OR '), limit) as Row[];
			console.log(`${rows.length} isabet (OR: ${terms.join(' ')})`);
			for (const r of rows) {
				console.log(`${chunkAnchor(r)} | ${r.path} | ${r.heading_path}`);
				console.log(`   ${r.display_text.replace(/\s+/g, ' ').slice(0, 200)}`);
			}
		} else {
			console.log('kullanım: inspect.ts chunks --vault <id> --path <p> | search --vault <id> --q "<terimler>" [--limit n]');
		}
	} finally {
		db.close();
	}
}

main();
