/**
 * Section and paging helpers for the MCP get_note tool. Pure (no I/O) so they are testable under
 * plain `tsx --test`.
 */

export interface Heading {
	/** 0-based line index. */
	line: number;
	/** 1-6 */
	level: number;
	text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** ATX headings (`# ...`), skipping fenced code blocks (``` or ~~~) so a `# comment` line inside code is
 * not a heading. A fence closes only on the same character with at least the opening length. */
export function findHeadings(markdown: string): Heading[] {
	const lines = markdown.split('\n');
	const out: Heading[] = [];
	let fence: { ch: string; len: number } | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/\r$/, '');
		const f = FENCE.exec(line);
		if (fence) {
			if (f && f[1][0] === fence.ch && f[1].length >= fence.len && line.trim() === f[1]) fence = null;
			continue;
		}
		if (f) {
			fence = { ch: f[1][0], len: f[1].length };
			continue;
		}
		const m = ATX.exec(line);
		if (m) out.push({ line: i, level: m[1].length, text: m[2].trim() });
	}
	return out;
}

export class HeadingNotFoundError extends Error {
	readonly available: string[];
	constructor(wanted: string, available: string[]) {
		super(`Başlık bulunamadı: "${wanted}". Notta bulunan başlıklar: ${available.length ? available.join(' | ') : '(yok)'}`);
		this.available = available;
	}
}

export interface Section {
	text: string;
	heading: string;
	level: number;
	/** How many headings matched; the first one is returned. */
	matches: number;
}

/**
 * The section whose heading equals `wanted` (leading #'s optional; exact match preferred, else
 * case-insensitive): the heading line through to the line before the next heading of the same or a
 * higher level (smaller or equal number of #). Nested deeper headings stay inside. Throws
 * HeadingNotFoundError listing the headings that exist.
 */
export function extractSection(markdown: string, wanted: string): Section {
	const headings = findHeadings(markdown);
	const query = wanted.replace(/^\s*#{1,6}[ \t]+/, '').trim();
	let hits = headings.filter((h) => h.text === query);
	if (hits.length === 0) hits = headings.filter((h) => h.text.toLowerCase() === query.toLowerCase());
	if (hits.length === 0) throw new HeadingNotFoundError(wanted, headings.map((h) => h.text));
	const h = hits[0];
	const next = headings.find((x) => x.line > h.line && x.level <= h.level);
	const lines = markdown.split('\n');
	const text = lines.slice(h.line, next ? next.line : lines.length).join('\n').replace(/\s+$/, '');
	return { text, heading: h.text, level: h.level, matches: hits.length };
}

export interface Page {
	text: string;
	offset: number;
	/** Characters of the full text before paging. */
	totalChars: number;
	/** Offset to pass for the next page, or null at the end. */
	nextOffset: number | null;
}

export function pageText(text: string, offset: number, maxChars: number): Page {
	const start = Math.min(Math.max(0, offset), text.length);
	const end = Math.min(text.length, start + maxChars);
	return { text: text.slice(start, end), offset: start, totalChars: text.length, nextOffset: end < text.length ? end : null };
}
