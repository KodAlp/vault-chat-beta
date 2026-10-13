// One-time repair of EXISTING library notes (TODO #4):
//   - Adobe-Symbol private-use codes (U+F0xx) -> Unicode,
//   - `\infty` between two terms -> `\propto`.
// The rules live in scripts/symbol-propto-repair.mjs (a port of ingest/postprocess.py).
//
//   npx tsx scripts/symbol-propto-repair.ts --vault <id> [--samples N] [--only <path-prefix>]   # DRY (default)
//   npx tsx scripts/symbol-propto-repair.ts --vault <id> --write [--only <path-prefix>]
//
// Data dir: DATA_DIR env (the installed app keeps its vaults in
// %APPDATA%\app.vaultchat.desktop), same as every other CLI here.
//
// DRY-RUN IS THE DEFAULT. --write goes through writeLibraryFile() -- the same
// door as the viewer's Save button: optimistic hash check, a snapshot of the
// previous text in <library>/_meta/revisions (the backup; restorable from the
// note's revision list), edit-log.jsonl, atomic replace, then the incremental
// re-index of that one file. Close the app (or at least do not edit the same
// notes) while this runs.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

try {
	process.loadEnvFile();
} catch {
	// .env is optional
}

const { resolveVault } = await import('../src/lib/server/vaults');
const { writeLibraryFile, sha256 } = await import('../src/lib/server/library-write');
// @ts-expect-error plain ESM without types
const { repairNote } = await import('./symbol-propto-repair.mjs');

const argv = process.argv.slice(2);
const arg = (flag: string): string | undefined => {
	const i = argv.indexOf(flag);
	return i !== -1 ? argv[i + 1] : undefined;
};
const write = argv.includes('--write');
const samples = Number(arg('--samples') ?? 3);
const only = arg('--only')?.replace(/\\/g, '/');

function walk(dir: string, out: string[] = []): string[] {
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		const st = fs.lstatSync(p);
		if (st.isSymbolicLink()) continue;
		if (st.isDirectory()) {
			if (name !== '_meta') walk(p, out);
		} else if (name.toLowerCase().endsWith('.md')) out.push(p);
	}
	return out;
}

function clip(s: string, n = 200): string {
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length > n ? `${t.slice(0, n)} ...(${t.length} kr)` : t;
}

const v = resolveVault(arg('--vault'));
console.log(`${write ? 'YAZMA' : 'KURU ÇALIŞMA (dosya değişmedi)'} - kasa: ${v.name} (${v.id}) - ${v.libraryRoot}`);

const totals = { files: 0, changed: 0, propto: 0, symbolMapped: 0, symbolUnmapped: 0, written: 0, indexPending: 0, failed: 0 };
for (const file of walk(v.libraryRoot)) {
	const rel = path.relative(v.libraryRoot, file).split(path.sep).join('/');
	if (only && !rel.startsWith(only)) continue;
	totals.files++;
	const source = fs.readFileSync(file, 'utf-8');
	const r = repairNote(source);
	totals.symbolUnmapped += r.symbol.unmapped;
	if (r.text === source) continue;
	totals.changed++;
	totals.propto += r.propto.length;
	totals.symbolMapped += r.symbol.mapped;
	console.log(`\n${rel}: \\propto ${r.propto.length}, Symbol kodu ${r.symbol.mapped}${r.symbol.unmapped ? ` (+${r.symbol.unmapped} eşlenmedi)` : ''}`);
	for (const p of r.propto.slice(0, samples)) {
		console.log(`    satır ${p.line}\n      önce:  ${clip(p.before)}\n      sonra: ${clip(p.after)}`);
	}
	if (r.symbol.mapped) {
		const line = source.split('\n').find((l) => /[-]/.test(l));
		const fixedLine = line ? r.text.split('\n')[source.split('\n').indexOf(line)] : undefined;
		if (line && fixedLine !== undefined) {
			console.log(`    Symbol örneği\n      önce:  ${clip(line.replace(/[-]/g, (c) => `<U+${c.charCodeAt(0).toString(16).toUpperCase()}>`))}\n      sonra: ${clip(fixedLine)}`);
		}
	}
	if (write) {
		try {
			const res = await writeLibraryFile(v, rel, r.text, sha256(source), { by: 'user' });
			totals.written++;
			if (res.indexPending) totals.indexPending++;
		} catch (err) {
			totals.failed++;
			console.log(`    YAZILAMADI: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

console.log(
	`\nÖzet: taranan ${totals.files}, değişecek not ${totals.changed}, \\propto ${totals.propto}, eşlenen Symbol kodu ${totals.symbolMapped}, eşlenmeyen özel kod ${totals.symbolUnmapped}` +
		(write ? `, yazılan ${totals.written}, indeks beklemede ${totals.indexPending}, başarısız ${totals.failed}` : '')
);
