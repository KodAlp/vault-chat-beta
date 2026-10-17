/**
 * "Re-read only the broken formula": pure helpers for the unreadable-formula blocks that
 * ingest/formula_fallback.py leaves in a converted note (see converted-images.ts for the image link):
 *
 *   ![Okunamayan formül — s. 87](../_meta/attachments/<sha16>.png)
 *   <!-- vc:formul-gorsel <sha16> s.87 [k=l,b,r,t] -->
 *
 *   > ⚠ Formül okunamadı — s. 87
 *
 *   <!-- vc:formul-latex <base64url of the best-attempt LaTeX> -->
 *
 * The blank lines and the trailing latex comment are optional; `k=` (PDF points, bottom-left origin)
 * only exists in newer imports. No filesystem or kit imports: unit-testable under plain tsx.
 */

export interface UnreadableFormula {
	/** Content hash of the crop image (16 hex chars) — the block's identity within a note. */
	sha: string;
	page: number;
	/** [left, bottom, right, top] in PDF points, or null for notes written before the marker carried it. */
	bbox: [number, number, number, number] | null;
	/** base64url (no padding) of the best-attempt LaTeX, or null when the note has none. */
	previousB64: string | null;
	/** Character range of the whole block in the text: first char of the image line .. end of the last
	 * block line (without its line break). */
	start: number;
	end: number;
}

export const FORMULA_MARKER_RE =
	/^<!--\s*vc:formul-gorsel\s+([0-9a-f]{16})\s+s\.(\d+)(?:\s+k=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?))?\s*-->\s*$/;
const LATEX_COMMENT_RE = /^<!--\s*vc:formul-latex\s+([A-Za-z0-9_-]*)\s*-->\s*$/;
const WARNING_RE = /^>\s*⚠/;
const IMAGE_LINE_RE = /^!\[[^\]\n]*\]\([^)\s]+(?:\s+"[^"\n]*")?\)\s*$/;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

interface Line {
	text: string;
	/** Offset of the first char. */
	from: number;
	/** Offset just past the last char of the text (before any \r\n). */
	to: number;
}

function splitLines(md: string): Line[] {
	const lines: Line[] = [];
	let from = 0;
	while (from <= md.length) {
		const nl = md.indexOf('\n', from);
		const rawEnd = nl === -1 ? md.length : nl;
		const to = rawEnd > from && md[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
		lines.push({ text: md.slice(from, to), from, to });
		if (nl === -1) break;
		from = nl + 1;
	}
	return lines;
}

export function findUnreadableFormulas(md: string): UnreadableFormula[] {
	const lines = splitLines(md);
	const found: UnreadableFormula[] = [];
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const f = FENCE_RE.exec(lines[i].text);
		if (f) {
			if (fence === null) fence = f[1][0];
			else if (f[1][0] === fence) fence = null;
			continue;
		}
		if (fence !== null) continue;
		const m = FORMULA_MARKER_RE.exec(lines[i].text);
		if (!m) continue;
		const startLine = i > 0 && IMAGE_LINE_RE.test(lines[i - 1].text) ? i - 1 : i;
		let last = i;
		let j = i + 1;
		const skipBlank = (k: number) => {
			while (k < lines.length && lines[k].text.trim() === '') k++;
			return k;
		};
		let previousB64: string | null = null;
		let k = skipBlank(j);
		if (k < lines.length && WARNING_RE.test(lines[k].text)) {
			last = k;
			j = k + 1;
			k = skipBlank(j);
		}
		const lm = k < lines.length ? LATEX_COMMENT_RE.exec(lines[k].text) : null;
		if (lm) {
			previousB64 = lm[1] || null;
			last = k;
		}
		found.push({
			sha: m[1],
			page: Number(m[2]),
			bbox: m[3] === undefined ? null : [Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])],
			previousB64,
			start: lines[startLine].from,
			end: lines[last].to
		});
		i = last;
	}
	return found;
}

/** Display-math block for `latex`, with the file's own line endings. */
function mathBlock(latex: string, eol: string): string {
	const body = latex.replace(/\r\n?|\n/g, '\n').trim().split('\n').join(eol);
	return `$$${eol}${body}${eol}$$`;
}

/**
 * Replaces the block with image `sha` by `$$ latex $$`. Returns null when no such block exists, when
 * `latex` is empty, or when it contains `$$` (which would end the math block early).
 */
export function replaceUnreadableFormula(md: string, sha: string, latex: string): string | null {
	const block = findUnreadableFormulas(md).find((b) => b.sha === sha);
	if (!block || !latex.trim() || latex.includes('$$')) return null;
	const eol = md.includes('\r\n') ? '\r\n' : '\n';
	return md.slice(0, block.start) + mathBlock(latex, eol) + md.slice(block.end);
}
