#!/usr/bin/env node
/**
 * Renders every math block in a Markdown file with the app's own KaTeX, so a
 * pass here means the viewer will render it. Nothing else in the repo checks
 * this: a broken `$$` block reaches the reader as a red KaTeX error, and a
 * `\begin{align}` written without `$$` reaches them as two half-derivations in
 * two different chunks.
 *
 *   node scripts/validate-math.mjs <file.md> [more.md ...]
 *
 * Exit 0 = clean, 1 = at least one ERROR. WARNs never fail the run.
 *
 * Three classes of problem, in the order they bite:
 *
 *  1. ERROR  KaTeX cannot render the block            -> visible error in the app
 *  2. ERROR  bare \begin{align|equation|gather}       -> not atomic to chunk.ts,
 *            outside any $$                              split like prose
 *  3. WARN   atomic block over HARD_MAX_CHARS         -> hardSplit() cuts it
 *            (2048)                                      mid-token
 *
 * Used by the knowledge-editor skill's VALIDATE step (skills/math.md) and
 * runnable by hand on anything in data/library/.
 */
import { readFileSync } from 'node:fs';
import katex from 'katex';

/** Mirrors indexer/chunk.ts. Imported by value rather than from the module
 * because that file is TypeScript and this script has to run under plain node. */
const HARD_MAX_CHARS = 2048;

const BARE_ENV = /\\begin\{(align|equation|gather|alignat|multline)\*?\}/g;

/** Replaces a span with spaces, keeping every newline, so later offsets and
 * line numbers stay exact. */
function blank(text, start, end) {
	const kept = text.slice(start, end).replace(/[^\n]/g, ' ');
	return text.slice(0, start) + kept + text.slice(end);
}

function lineOf(text, index) {
	let line = 1;
	for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
	return line;
}

/** Strips YAML frontmatter and fenced code, which are not math and routinely
 * contain `$` (shell prompts, template literals, currency in a table). */
function stripNonMath(source) {
	let text = source;

	const fm = /^---\n[\s\S]*?\n---\n/.exec(text);
	if (fm) text = blank(text, 0, fm[0].length);

	const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
	let m;
	while ((m = fence.exec(text))) {
		text = blank(text, m.index, m.index + m[0].length);
		fence.lastIndex = m.index + m[0].length;
	}

	const inlineCode = /`[^`\n]*`/g;
	while ((m = inlineCode.exec(text))) {
		text = blank(text, m.index, m.index + m[0].length);
	}

	return text;
}

/** Display first, then inline over what is left — otherwise the two `$` of a
 * `$$` open delimiter read as an empty inline expression. */
function findMath(text) {
	const found = [];
	let rest = text;

	const display = /\$\$([\s\S]*?)\$\$/g;
	let m;
	while ((m = display.exec(rest))) {
		found.push({ kind: 'display', body: m[1], index: m.index, length: m[0].length });
	}
	for (const f of found) rest = blank(rest, f.index, f.index + f.length);

	// Approximates @vscode/markdown-it-katex's inline rule: the opening `$` is
	// not followed by whitespace, the closing `$` is not preceded by one, and
	// neither is escaped. Keeps "costs $5 or $10" from parsing as math.
	const inline = /(?<!\\)\$(?![\s$])((?:[^$\\\n]|\\.)+?)(?<![\s\\])\$(?!\d)/g;
	while ((m = inline.exec(rest))) {
		found.push({ kind: 'inline', body: m[1], index: m.index, length: m[0].length });
	}

	return found.sort((a, b) => a.index - b.index);
}

function checkFile(path) {
	const source = readFileSync(path, 'utf-8');
	const text = stripNonMath(source);
	const problems = [];

	for (const block of findMath(text)) {
		const line = lineOf(text, block.index);
		try {
			katex.renderToString(block.body, {
				displayMode: block.kind === 'display',
				throwOnError: true,
				strict: false
			});
		} catch (err) {
			problems.push({
				level: 'ERROR',
				line,
				message: `KaTeX (${block.kind}): ${err.message.split('\n')[0]}`
			});
		}
		if (block.length > HARD_MAX_CHARS) {
			problems.push({
				level: 'WARN',
				line,
				message: `math block is ${block.length} chars (> ${HARD_MAX_CHARS}); hardSplit() will cut it mid-token`
			});
		}
	}

	// A display environment left outside any $$ is invisible to splitAtomicBlocks().
	const outsideMath = findMath(text).reduce(
		(acc, b) => blank(acc, b.index, b.index + b.length),
		text
	);
	let m;
	BARE_ENV.lastIndex = 0;
	while ((m = BARE_ENV.exec(outsideMath))) {
		problems.push({
			level: 'ERROR',
			line: lineOf(outsideMath, m.index),
			message: `\\begin{${m[1]}} outside $$ — not atomic to chunk.ts, will be split like prose`
		});
	}

	// Fenced code is atomic too, and subject to the same cap.
	const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
	while ((m = fence.exec(source))) {
		if (m[0].length > HARD_MAX_CHARS) {
			problems.push({
				level: 'WARN',
				line: lineOf(source, m.index),
				message: `code fence is ${m[0].length} chars (> ${HARD_MAX_CHARS}); hardSplit() will cut it mid-line`
			});
		}
	}

	return problems.sort((a, b) => a.line - b.line);
}

const files = process.argv.slice(2);
if (files.length === 0) {
	console.error('kullanım: node scripts/validate-math.mjs <file.md> [...]');
	process.exit(2);
}

let errors = 0;
let warns = 0;

for (const file of files) {
	let problems;
	try {
		problems = checkFile(file);
	} catch (err) {
		console.error(`${file}: okunamadı — ${err.message}`);
		errors++;
		continue;
	}
	for (const p of problems) {
		console.log(`${file}:${p.line}: ${p.level} ${p.message}`);
		if (p.level === 'ERROR') errors++;
		else warns++;
	}
}

const summary = `${files.length} dosya, ${errors} hata, ${warns} uyarı`;
console.log(errors === 0 ? `OK — ${summary}` : `BAŞARISIZ — ${summary}`);
process.exit(errors === 0 ? 0 : 1);
