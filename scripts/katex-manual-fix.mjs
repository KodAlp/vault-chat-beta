#!/usr/bin/env node
/**
 * Applies hand-checked formula fixes (each one compared with the source PDF)
 * to MinerU-converted raw books. Companion of katex-cleanup.mjs: that script
 * only does mechanical, provably safe rewrites; the rest is decided by a human
 * and recorded in a fixes file (see docs/dev/katex-elle-*.json).
 *
 *   node scripts/katex-manual-fix.mjs <libraryDir> <fixes.json>                          # DRY (default)
 *   node scripts/katex-manual-fix.mjs <libraryDir> <fixes.json> --write --backup-dir <dir>
 *
 * A fix is { file, line, body } plus one of `to`, `bodyEdits` or `find`/`replace`:
 *   - file/line/body identify ONE formula exactly as findMath() reports it
 *     (body without delimiters; line = 1-based line of its opening delimiter).
 *   - `to` replaces the whole formula INCLUDING its delimiters ("$...$", "$$...$$"),
 *     so a fix may also turn junk into plain text.
 *     With `all: true` every identical formula on that line is replaced (table rows).
 *   - `bodyEdits` [[find, replace], ...] edits inside the body, each `find` unique
 *     in it; delimiters and their line breaks are kept (long display arrays).
 *   - `find`/`replace` replaces a substring that must occur exactly once on that
 *     line (for fixes that reach outside the formula, e.g. "$Y_S ' _s$" -> "$Y_S$'s").
 * Every fix must leave KaTeX-valid math behind (all formulas inside `to` /
 * the edited line are re-checked); a fix whose formula is not found, is
 * ambiguous, or still fails KaTeX is reported and skipped, never half-applied.
 * Files are written atomically; the original goes to --backup-dir first.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findMath, katexError, splitFrontmatter } from './katex-cleanup.mjs';

function lineOf(text, index) {
	let n = 1;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

/** null when every formula in `snippet` renders, else the first error. */
function snippetError(snippet) {
	for (const f of findMath(snippet)) {
		const err = katexError(f.body, f.kind === 'display');
		if (err) return err;
	}
	return null;
}

/**
 * Pure: applies the fixes for one file's text. Returns { text, applied:[fix], skipped:[{fix, reason}] }.
 * Fixes are applied back to front so earlier offsets stay valid.
 */
export function applyFixes(source, fixes) {
	const [fm, body] = splitFrontmatter(source);
	const fmLines = fm ? fm.split('\n').length - 1 : 0;
	// findMath returns formulas in document order: count newlines incrementally.
	let line = 1;
	let at = 0;
	const found = findMath(body).map((f) => {
		line += lineOf(body.slice(at, f.start), f.start - at) - 1;
		at = f.start;
		return { ...f, line: line + fmLines };
	});
	const crlf = body.includes('\r\n');
	const plan = [];
	const skipped = [];
	for (const fix of fixes) {
		const hits = found.filter((f) => f.line === fix.line && f.body === fix.body);
		// `all` (with `to` only): every identical formula on that line gets the same replacement.
		if (fix.all && typeof fix.to === 'string' && hits.length > 1) {
			const err = snippetError(fix.to);
			if (err) skipped.push({ fix, reason: `düzeltme hâlâ KaTeX hatası veriyor: ${err}` });
			else for (const h of hits) plan.push({ fix, start: h.start, end: h.end, to: crlf ? fix.to.replace(/\r?\n/g, '\r\n') : fix.to });
			continue;
		}
		if (hits.length !== 1) {
			skipped.push({ fix, reason: hits.length ? 'formül satırda birden çok kez var' : 'formül bulunamadı (dosya değişmiş olabilir)' });
			continue;
		}
		const f = hits[0];
		let start, end, to;
		if (typeof fix.to === 'string') {
			[start, end, to] = [f.start, f.end, fix.to];
		} else if (Array.isArray(fix.bodyEdits)) {
			let b = f.body;
			let bad = null;
			for (const [find, replace] of fix.bodyEdits) {
				const at = b.indexOf(find);
				if (at === -1 || b.indexOf(find, at + 1) !== -1) {
					bad = `${at === -1 ? 'gövdede yok' : 'gövdede birden çok kez var'}: ${find}`;
					break;
				}
				b = b.slice(0, at) + replace + b.slice(at + find.length);
			}
			if (bad) {
				skipped.push({ fix, reason: bad });
				continue;
			}
			[start, end, to] = [f.start, f.end, f.open + b + f.close];
		} else {
			const ls = body.lastIndexOf('\n', f.start) + 1;
			let le = body.indexOf('\n', f.end);
			if (le === -1) le = body.length;
			const lineText = body.slice(ls, le);
			const at = lineText.indexOf(fix.find);
			if (at === -1 || lineText.indexOf(fix.find, at + 1) !== -1) {
				skipped.push({ fix, reason: at === -1 ? '`find` satırda yok' : '`find` satırda birden çok kez var' });
				continue;
			}
			[start, end, to] = [ls + at, ls + at + fix.find.length, fix.replace];
		}
		if (crlf) to = to.replace(/\r?\n/g, '\r\n');
		const err = snippetError(to);
		if (err) {
			skipped.push({ fix, reason: `düzeltme hâlâ KaTeX hatası veriyor: ${err}` });
			continue;
		}
		plan.push({ fix, start, end, to });
	}
	plan.sort((a, b) => b.start - a.start);
	for (let i = 1; i < plan.length; i++) {
		if (plan[i].end > plan[i - 1].start) throw new Error(`çakışan düzeltmeler: satır ${plan[i].fix.line} ve ${plan[i - 1].fix.line}`);
	}
	let out = body;
	for (const p of plan) out = out.slice(0, p.start) + p.to + out.slice(p.end);
	return { text: fm + out, applied: plan.map((p) => p.fix).reverse(), skipped };
}

function insideDir(p, dir) {
	const r = relative(resolve(dir), resolve(p));
	return r === '' || (!r.startsWith('..') && !r.startsWith(sep) && !/^[a-zA-Z]:/.test(r));
}

function main(argv) {
	const pos = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--backup-dir');
	const write = argv.includes('--write');
	const bi = argv.indexOf('--backup-dir');
	const backupDir = bi === -1 ? null : argv[bi + 1];
	const [dir, fixesPath] = pos;
	if (!dir || !fixesPath) {
		console.error('kullanım: node scripts/katex-manual-fix.mjs <libraryDir> <fixes.json> [--write --backup-dir <dir>]');
		process.exit(2);
	}
	if (write && !backupDir) {
		console.error('--write için --backup-dir zorunlu.');
		process.exit(2);
	}
	if (backupDir && insideDir(backupDir, dir)) {
		console.error('--backup-dir kütüphane klasörünün içinde olamaz.');
		process.exit(2);
	}
	const all = JSON.parse(readFileSync(fixesPath, 'utf-8')).fixes;
	const byFile = new Map();
	for (const f of all) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
	let applied = 0;
	let skipped = 0;
	console.log(`${write ? 'YAZMA' : 'KURU ÇALIŞMA (dosya değişmedi)'} — ${dir}`);
	for (const [file, fixes] of byFile) {
		const abs = join(dir, file);
		const source = readFileSync(abs, 'utf-8');
		const r = applyFixes(source, fixes);
		applied += r.applied.length;
		skipped += r.skipped.length;
		console.log(`  ${file}: uygulanan ${r.applied.length}, atlanan ${r.skipped.length}`);
		for (const s of r.skipped) console.log(`    ATLANDI satır ${s.fix.line}: ${s.reason}`);
		if (write && r.applied.length && r.text !== source) {
			const bpath = join(backupDir, file);
			mkdirSync(dirname(bpath), { recursive: true });
			if (existsSync(bpath)) throw new Error(`yedek zaten var, üzerine yazılmaz: ${bpath}`);
			writeFileSync(bpath, source, { encoding: 'utf-8', flag: 'wx' });
			const tmp = `${abs}.tmp-${process.pid}`;
			writeFileSync(tmp, r.text, 'utf-8');
			renameSync(tmp, abs);
		}
	}
	console.log(`\nuygulanan: ${applied}  atlanan: ${skipped}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
