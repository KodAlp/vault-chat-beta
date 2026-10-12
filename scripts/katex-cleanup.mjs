#!/usr/bin/env node
/**
 * Mechanical KaTeX cleanup for MinerU-converted raw books.
 *
 *   node scripts/katex-cleanup.mjs <libraryDir> [--all] [--report out.json] [--samples N]
 *   node scripts/katex-cleanup.mjs <libraryDir> --write --backup-dir <dir>
 *
 * DRY-RUN IS THE DEFAULT: nothing is written unless --write is given, and
 * --write requires --backup-dir (backups next to the files would pollute the
 * vault and the indexer). Writes are atomic (temp file + rename).
 *
 * Accuracy first ("kesik formül başarı değil"): a fix only ever REMOVES a
 * redundant/orphaned token or REPLACES a glyph by an unambiguous equivalent;
 * it never truncates or guesses content. Every candidate is re-rendered with
 * KaTeX and accepted only if KaTeX now accepts it; otherwise the original is
 * left untouched. Code / pseudo-code mistaken for a formula is only REPORTED
 * ("kod sanılmış"), never touched.
 *
 * Fix order (pure functions, exported for tests):
 *   1. fixDuplicateTag   - several \tag in one formula: keep the LAST one.
 *      MinerU emits the model's own (often truncated, e.g. "\tag {9.}") number
 *      first and the number printed in the book's layout last
 *      ("...\tag {1}\tag{15.11}"). The last is the book's real equation number.
 *   2. fixStrayDelimiters - orphan `\]` `\[` `\(` `\)` (leftover delimiters) and
 *      the broken `\tag{\( ... \}` form (tag text wrapped in a stray `\(`).
 *   3. fixHtmlEntities - `&lt;` `&gt;` left in the formula by the HTML-ish
 *      converter output are decoded to `<` `>` (`&amp;` is NOT touched: inside
 *      an array it may be an alignment tab).
 *   4. fixMacroAliases - macros KaTeX lacks that have an exact equivalent:
 *      \hdots -> \ldots, \textless -> <, \textgreater -> >, \textmu -> \mu.
 *   5. fixGlyphJunk - OCR junk with one unambiguous reading: `\/` -> `/`.
 *      (`\Ss` etc. have no unambiguous mapping and are left alone.)
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import katex from 'katex';

/* ------------------------------------------------------------------ math location */

function blank(text, start, end) {
	return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, ' ') + text.slice(end);
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\n]*?)\r?$/;
const MATH_RE = /^ {0,3}\$\$[\s\S]*?\$\$[ \t\r]*$/my;

/** Same rules as indexer/chunk.ts findAtomicSpans (copied: that file is TS and
 * this script runs under plain node). Fence + line-start `$$ ... $$` spans. */
export function findAtomicSpans(text) {
	const spans = [];
	let pos = 0;
	while (pos < text.length) {
		let eol = text.indexOf('\n', pos);
		if (eol === -1) eol = text.length;
		const line = text.slice(pos, eol);
		const next = eol + 1;
		const open = FENCE_OPEN.exec(line);
		if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
			const fence = open[1];
			const closeRe = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}[ \t]*\r?$');
			let q = next;
			let closedAt = -1;
			while (q <= text.length) {
				let e = text.indexOf('\n', q);
				if (e === -1) e = text.length;
				if (closeRe.test(text.slice(q, e))) {
					closedAt = e;
					break;
				}
				if (e >= text.length) break;
				q = e + 1;
			}
			if (closedAt !== -1) {
				let end = closedAt;
				if (text[end - 1] === '\r') end -= 1;
				spans.push({ type: 'code', start: pos, end });
				pos = closedAt + 1;
				continue;
			}
		} else if (/^ {0,3}\$\$/.test(line)) {
			MATH_RE.lastIndex = pos;
			const m = MATH_RE.exec(text);
			if (m) {
				let end = pos + m[0].length;
				if (text[end - 1] === '\r') end -= 1;
				spans.push({ type: 'math', start: pos, end });
				pos = pos + m[0].length + 1;
				continue;
			}
		}
		pos = next;
	}
	return spans;
}

/**
 * Locates formulas in a document body (frontmatter excluded by the caller).
 * Returns [{kind:'display'|'inline', open, close, body, start, end}] where
 * text.slice(start,end) === open+body+close, in document order.
 * Display: line-start `$$` blocks (as the indexer) and `\[ ... \]`.
 * Inline: `$...$` with validate-math.mjs rules. Fenced code and inline code
 * are never searched.
 */
export function findMath(text) {
	const found = [];
	let rest = text;
	for (const s of findAtomicSpans(text)) {
		if (s.type === 'math') {
			const raw = text.slice(s.start, s.end);
			const o = raw.indexOf('$$');
			const c = raw.lastIndexOf('$$');
			found.push({
				kind: 'display',
				open: '$$',
				close: '$$',
				body: raw.slice(o + 2, c),
				start: s.start + o,
				end: s.start + c + 2
			});
		}
		rest = blank(rest, s.start, s.end);
	}
	let m;
	const inlineCode = /`[^`\n]*`/g;
	while ((m = inlineCode.exec(rest))) rest = blank(rest, m.index, m.index + m[0].length);

	const bracket = /\\\[([\s\S]*?)\\\]/g;
	while ((m = bracket.exec(rest))) {
		found.push({ kind: 'display', open: '\\[', close: '\\]', body: m[1], start: m.index, end: m.index + m[0].length });
		rest = blank(rest, m.index, m.index + m[0].length);
	}
	// Other `$$` (not line-start) are not math to the indexer: skip them.
	const dollars = /\$\$[\s\S]*?\$\$/g;
	while ((m = dollars.exec(rest))) rest = blank(rest, m.index, m.index + m[0].length);

	const inline = /(?<!\\)\$(?![\s$])((?:[^$\\\n]|\\.)+?)(?<![\s\\])\$(?!\d)/g;
	while ((m = inline.exec(rest))) {
		found.push({ kind: 'inline', open: '$', close: '$', body: m[1], start: m.index, end: m.index + m[0].length });
	}
	return found.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ KaTeX gate */

/** null when KaTeX accepts the formula, otherwise the first error line. */
export function katexError(body, display = true) {
	try {
		katex.renderToString(body, { displayMode: display, throwOnError: true, strict: false });
		return null;
	} catch (err) {
		return String(err && err.message ? err.message : err).split('\n')[0];
	}
}

/* ------------------------------------------------------------------ fixes */

/** Index of the `}` closing the `{` at `open`, honouring escapes; -1 if unbalanced. */
function matchBrace(s, open) {
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		const ch = s[i];
		if (ch === '\\') {
			i++;
			continue;
		}
		if (ch === '{') depth++;
		else if (ch === '}' && --depth === 0) return i;
	}
	return -1;
}

/** Well-formed `\tag{...}` / `\tag*{...}` occurrences: [{start,end}]. */
function findTags(body) {
	const tags = [];
	const re = /\\tag\*?\s*\{/g;
	let m;
	while ((m = re.exec(body))) {
		const open = m.index + m[0].length - 1;
		const close = matchBrace(body, open);
		if (close === -1) continue;
		tags.push({ start: m.index, end: close + 1 });
		re.lastIndex = close + 1;
	}
	return tags;
}

/** Several \tag -> keep only the last. Returns the new body or null when not applicable. */
export function fixDuplicateTag(body) {
	const tags = findTags(body);
	if (tags.length < 2) return null;
	let out = '';
	let pos = 0;
	for (const t of tags.slice(0, -1)) {
		out += body.slice(pos, t.start);
		pos = t.end;
	}
	out += body.slice(pos);
	return out.replace(/[ \t]{2,}/g, ' ');
}

/**
 * Stray delimiters. (a) `\tag{\( X \}` -> `\tag{X}`: the tag text was wrapped in
 * an opened-but-never-closed `\(` and the closing brace was mangled to `\}`.
 * Only applied when X is plain short text. (b) a lone `\]` `\[` `\(` `\)` with
 * no partner in the body is deleted.
 */
export function fixStrayDelimiters(body) {
	let out = body;
	out = out.replace(/\\tag\*?\s*\{\s*\\\(\s*([^{}\\]{1,40}?)\s*\\\}/g, (_, t) => `\\tag{${t}}`);
	const count = (re) => (out.match(re) || []).length;
	if (count(/\\\]/g) > count(/\\\[/g)) out = out.replace(/\\\]/g, '');
	if (count(/\\\[/g) > count(/\\\]/g)) out = out.replace(/\\\[/g, '');
	if (count(/\\\)/g) > count(/\\\(/g)) out = out.replace(/\\\)/g, '');
	if (count(/\\\(/g) > count(/\\\)/g)) out = out.replace(/\\\(/g, '');
	return out === body ? null : out;
}

/** OCR junk with a single unambiguous reading: `\/` -> `/`. */
export function fixGlyphJunk(body) {
	const out = body.replace(/\\\/(?!\w)/g, '/');
	return out === body ? null : out;
}

/** `&lt;` / `&gt;` -> `<` / `>`. */
export function fixHtmlEntities(body) {
	const out = body.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
	return out === body ? null : out;
}

const MACRO_ALIASES = [
	[/\\hdots(?![a-zA-Z])/g, '\\ldots'],
	[/\\textless(?![a-zA-Z])/g, '<'],
	[/\\textgreater(?![a-zA-Z])/g, '>'],
	[/\\textmu(?![a-zA-Z])/g, '\\mu']
];

/** Undefined-in-KaTeX macros with an exact equivalent. */
export function fixMacroAliases(body) {
	let out = body;
	for (const [re, to] of MACRO_ALIASES) out = out.replace(re, () => to);
	return out === body ? null : out;
}

export const FIXES = [
	['duplicate-tag', fixDuplicateTag],
	['stray-delimiter', fixStrayDelimiters],
	['html-entity', fixHtmlEntities],
	['macro-alias', fixMacroAliases],
	['glyph-junk', fixGlyphJunk]
];

/** Code / assembly / pseudo-code mistaken for a formula (report only). */
export function looksLikeCode(body) {
	if (/\\text\s*\{[^}]*[_$][^}]*\}/.test(body)) return true;
	if (/\\mathrm\s*\{\s*(?:lw|sw|addi?u?|beq|bne|jal|jr|lui|ori|andi|slt|sll|srl|move|syscall|mov|push|pop|cmp|jmp)\s*\}/.test(body)) return true;
	if (/\$\s*(?:zero|at|v[01]|a[0-3]|t\d|s\d|sp|fp|ra|gp)\b/.test(body)) return true;
	if (/\\(?:text|mathrm|texttt)\s*\{\s*(?:if|else|while|for|return|function|def|int|void)\b/.test(body)) return true;
	return false;
}

/**
 * Tries each fix cumulatively, re-running KaTeX after each step; a candidate
 * is accepted only if KaTeX renders it. Returns
 * {status:'ok'} | {status:'fixed', body, applied} | {status:'code-like', error} | {status:'unfixable', error}.
 */
export function repairFormula(body, display = true) {
	const err0 = katexError(body, display);
	if (!err0) return { status: 'ok' };
	if (looksLikeCode(body)) return { status: 'code-like', error: err0 };

	let cur = body;
	const applied = [];
	for (const [name, fn] of FIXES) {
		const cand = fn(cur);
		if (cand === null || cand === cur) continue;
		cur = cand;
		applied.push(name);
		if (!katexError(cur, display)) return { status: 'fixed', body: cur, applied };
	}
	return { status: 'unfixable', error: err0 };
}

/* ------------------------------------------------------------------ file processing */

export function splitFrontmatter(source) {
	const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(source);
	return m ? [m[0], source.slice(m[0].length)] : ['', source];
}

export function isMineru(frontmatter) {
	return /^converter:\s*["']?mineru["']?\s*$/m.test(frontmatter);
}

/** Pure: {text, formulas, fixed:[{line,body,after,applied}], unfixable:[...], codeLike:[...]}. */
export function processText(source) {
	const [fm, body] = splitFrontmatter(source);
	const math = findMath(body);
	const result = { formulas: math.length, fixed: [], unfixable: [], codeLike: [] };
	const fmLines = fm.split('\n').length - 1;
	let out = '';
	let pos = 0;
	for (const f of math) {
		const r = repairFormula(f.body, f.kind === 'display');
		if (r.status === 'ok') continue;
		const entry = { line: body.slice(0, f.start).split('\n').length + fmLines, body: f.body };
		if (r.status === 'fixed') {
			out += body.slice(pos, f.start) + f.open + r.body + f.close;
			pos = f.end;
			result.fixed.push({ ...entry, after: r.body, applied: r.applied });
		} else if (r.status === 'code-like') result.codeLike.push({ ...entry, error: r.error });
		else result.unfixable.push({ ...entry, error: r.error });
	}
	out += body.slice(pos);
	result.text = fm + out;
	return result;
}

function walk(dir, files = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, files);
		else if (name.toLowerCase().endsWith('.md')) files.push(p);
	}
	return files;
}

function atomicWrite(path, content) {
	const tmp = `${path}.katex-cleanup.tmp`;
	writeFileSync(tmp, content, 'utf-8');
	renameSync(tmp, path);
}

function clip(s, n = 220) {
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length > n ? `${t.slice(0, n)} ...(${t.length} kr)` : t;
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv) {
	const a = { dir: null, all: false, write: false, backupDir: null, report: null, samples: 5 };
	for (let i = 0; i < argv.length; i++) {
		const x = argv[i];
		if (x === '--all') a.all = true;
		else if (x === '--write') a.write = true;
		else if (x === '--backup-dir') a.backupDir = argv[++i];
		else if (x === '--report') a.report = argv[++i];
		else if (x === '--samples') a.samples = Number(argv[++i]);
		else if (!x.startsWith('--') && !a.dir) a.dir = x;
		else throw new Error(`bilinmeyen argüman: ${x}`);
	}
	return a;
}

function insideDir(child, parent) {
	return (resolve(child) + sep).startsWith(resolve(parent) + sep);
}

function main() {
	console.warn = () => {}; // KaTeX's "No character metrics" noise
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (e) {
		console.error(e.message);
		process.exit(2);
	}
	if (!args.dir) {
		console.error('kullanım: node scripts/katex-cleanup.mjs <libraryDir> [--all] [--report f.json] [--samples N] [--write --backup-dir <dir>]');
		process.exit(2);
	}
	if (args.write && !args.backupDir) {
		console.error('--write için --backup-dir zorunlu (yedek kasanın içine yazılamaz).');
		process.exit(2);
	}
	if (args.backupDir && insideDir(args.backupDir, args.dir)) {
		console.error('--backup-dir kütüphane klasörünün içinde olamaz.');
		process.exit(2);
	}
	if (args.report && insideDir(args.report, args.dir)) {
		console.error('--report kütüphane klasörünün içinde olamaz.');
		process.exit(2);
	}

	const files = walk(args.dir);
	const totals = { files: 0, scanned: 0, formulas: 0, fixed: 0, unfixable: 0, codeLike: 0, modified: 0 };
	const byFix = {};
	const perFile = [];
	const samples = [];

	for (const file of files) {
		totals.files++;
		const source = readFileSync(file, 'utf-8');
		const [fm] = splitFrontmatter(source);
		if (!args.all && !isMineru(fm)) continue;
		totals.scanned++;
		const r = processText(source);
		totals.formulas += r.formulas;
		totals.fixed += r.fixed.length;
		totals.unfixable += r.unfixable.length;
		totals.codeLike += r.codeLike.length;
		for (const f of r.fixed) {
			const k = f.applied.join('+');
			byFix[k] = (byFix[k] || 0) + 1;
			if (samples.length < args.samples * 3) {
				samples.push({ file: relative(args.dir, file), line: f.line, applied: k, before: clip(f.body), after: clip(f.after) });
			}
		}
		if (r.fixed.length || r.unfixable.length || r.codeLike.length) {
			perFile.push({
				file: relative(args.dir, file),
				fixed: r.fixed.length,
				unfixable: r.unfixable.length,
				codeLike: r.codeLike.length,
				unfixableSamples: r.unfixable.slice(0, 3).map((u) => ({ line: u.line, error: u.error, body: clip(u.body, 160) })),
				codeLikeSamples: r.codeLike.slice(0, 2).map((u) => ({ line: u.line, body: clip(u.body, 160) }))
			});
		}
		if (args.write && r.fixed.length && r.text !== source) {
			const bpath = join(args.backupDir, relative(args.dir, file));
			mkdirSync(dirname(bpath), { recursive: true });
			if (existsSync(bpath)) throw new Error(`yedek zaten var, üzerine yazılmaz: ${bpath}`);
			writeFileSync(bpath, source, { encoding: 'utf-8', flag: 'wx' });
			atomicWrite(file, r.text);
			totals.modified++;
		}
	}

	console.log(`${args.write ? 'YAZMA' : 'KURU ÇALIŞMA (dosya değişmedi)'} — ${args.dir}`);
	for (const f of perFile) {
		console.log(`  ${f.file}: düzeltilen ${f.fixed}, düzeltilemeyen ${f.unfixable}, kod sanılmış ${f.codeLike}`);
	}
	console.log('');
	console.log(`taranan dosya: ${totals.scanned}/${totals.files}, formül: ${totals.formulas}`);
	console.log(`düzeltilen: ${totals.fixed}  (${Object.entries(byFix).map(([k, v]) => `${k}=${v}`).join(', ') || '-'})`);
	console.log(`düzeltilemeyen: ${totals.unfixable}`);
	console.log(`kod sanılmış (elle bakılacak): ${totals.codeLike}`);
	if (args.write) console.log(`değiştirilen dosya: ${totals.modified}`);
	if (samples.length) {
		console.log('\nörnekler:');
		for (const s of samples) {
			console.log(`- ${s.file}:${s.line} [${s.applied}]\n    önce: ${s.before}\n    sonra: ${s.after}`);
		}
	}
	if (args.report) {
		mkdirSync(dirname(resolve(args.report)), { recursive: true });
		writeFileSync(args.report, JSON.stringify({ totals, byFix, files: perFile, samples }, null, 2), 'utf-8');
		console.log(`\nrapor: ${args.report}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
