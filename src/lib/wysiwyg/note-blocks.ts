/**
 * Block-preserving note model for the WYSIWYG editor (pure, no DOM).
 *
 * Why this exists: serializing a whole note out of a rich-text editor rewrites
 * bytes the user never touched (escapes, list markers, table padding, setext
 * headings, entities, ...) and sometimes changes what the viewer shows. So the
 * editor never serializes the note. Instead the note is cut into its top-level
 * Markdown blocks, every block keeps its ORIGINAL source slice plus the exact
 * whitespace gap before it, and saving re-emits the original slice for every
 * block the user did not touch. Only edited / new blocks are re-serialized.
 * A zero-edit save is therefore byte-identical by construction.
 *
 * Offsets come from the same remark stack the editor uses (remark-parse +
 * gfm + math), so a `$$` block that contains blank lines stays one block.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/** Same pattern the library viewer uses to hide frontmatter (+page.svelte render()). */
export const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

export type Eol = '\n' | '\r\n';

export interface NotePart {
	/** Verbatim whitespace between the previous block (or the frontmatter) and this block. */
	gap: string;
	/** Verbatim source of the block, line endings untouched. */
	src: string;
}

export interface NoteModel {
	/** Verbatim frontmatter incl. its closing fence line ('' when the note has none). */
	frontmatter: string;
	/** Dominant line ending; used only for text we serialize ourselves. */
	eol: Eol;
	parts: NotePart[];
	/** Verbatim text after the last block. */
	tail: string;
}

/** One top-level block of the edited document, as the editor layer reports it. */
export type OutItem =
	| { keep: number }
	| {
			/** Re-serialized Markdown (LF, no trailing newline). */
			text: string;
			/** Original block this one was edited from: its gap is reused. */
			inheritGap?: number | null;
	  };

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

export function detectEol(raw: string): Eol {
	let crlf = 0;
	let lf = 0;
	for (let i = raw.indexOf('\n'); i !== -1; i = raw.indexOf('\n', i + 1)) {
		if (i > 0 && raw[i - 1] === '\r') crlf++;
		else lf++;
	}
	return crlf > lf ? '\r\n' : '\n';
}

export function toLf(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

function single(frontmatter: string, body: string, eol: Eol): NoteModel {
	return { frontmatter, eol, parts: body === '' ? [] : [{ gap: '', src: body }], tail: '' };
}

/** Cut a note into frontmatter + blocks. Never throws; if the parse cannot be
 * proven lossless the whole body becomes ONE block (which the safety gate then
 * judges as a unit), so assemble() of an untouched model always equals `raw`. */
export function splitNote(raw: string): NoteModel {
	const eol = detectEol(raw);
	const fm = FRONTMATTER_RE.exec(raw)?.[0] ?? '';
	const body = raw.slice(fm.length);
	let model: NoteModel;
	try {
		const tree = processor.parse(body);
		const parts: NotePart[] = [];
		let cursor = 0;
		for (const node of tree.children) {
			const start = node.position?.start.offset;
			const end = node.position?.end.offset;
			if (start === undefined || end === undefined || start < cursor || end < start) return single(fm, body, eol);
			parts.push({ gap: body.slice(cursor, start), src: body.slice(start, end) });
			cursor = end;
		}
		model = { frontmatter: fm, eol, parts, tail: body.slice(cursor) };
	} catch {
		return single(fm, body, eol);
	}
	return assemble(model, model.parts.map((_, i) => ({ keep: i }))) === raw ? model : single(fm, body, eol);
}

/** Re-join the note. Kept blocks come back byte for byte; `text` blocks get
 * the note's own line ending. */
export function assemble(model: NoteModel, items: OutItem[]): string {
	const out: string[] = [model.frontmatter];
	let first = true;
	for (const item of items) {
		if ('keep' in item) {
			const p = model.parts[item.keep];
			out.push(p.gap, p.src);
		} else {
			const inherit = item.inheritGap != null ? model.parts[item.inheritGap]?.gap : undefined;
			const gap = inherit ?? (first ? '' : model.eol + model.eol);
			out.push(gap, model.eol === '\n' ? item.text : item.text.replace(/\n/g, model.eol));
		}
		first = false;
	}
	out.push(model.tail);
	return out.join('');
}

export interface Alignment {
	kind: 'same' | 'edited' | 'new';
	/** same: the identical original block; edited: the block it replaces (gap inherited); new: null. */
	orig: number | null;
}

/**
 * Match the current blocks to the original ones by an equality key (the editor
 * layer uses the ProseMirror node JSON). Common prefix/suffix are peeled off
 * first so a local edit costs O(n); the middle is matched by LCS, and
 * unmatched blocks between two anchors are paired in order as "edited".
 */
export function alignBlocks(orig: string[], cur: string[]): Alignment[] {
	const res: Alignment[] = new Array(cur.length);
	let lo = 0;
	while (lo < orig.length && lo < cur.length && orig[lo] === cur[lo]) {
		res[lo] = { kind: 'same', orig: lo };
		lo++;
	}
	let oEnd = orig.length;
	let cEnd = cur.length;
	while (oEnd > lo && cEnd > lo && orig[oEnd - 1] === cur[cEnd - 1]) {
		oEnd--;
		cEnd--;
		res[cEnd] = { kind: 'same', orig: oEnd };
	}
	const n = oEnd - lo;
	const m = cEnd - lo;
	const matchOfCur = new Array<number>(m).fill(-1);
	if (n > 0 && m > 0 && n * m <= 4_000_000) {
		// classic LCS table over the (small) middle
		const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				dp[i][j] = orig[lo + i] === cur[lo + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (orig[lo + i] === cur[lo + j]) matchOfCur[j++] = lo + i++;
			else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
			else j++;
		}
	}
	// walk the middle: anchors are matched pairs, runs between them are paired as edits
	let oPtr = lo;
	let runStartC = 0;
	const flush = (cUntil: number, oUntil: number) => {
		let o = oPtr;
		for (let c = runStartC; c < cUntil; c++) {
			if (o < oUntil) res[lo + c] = { kind: 'edited', orig: o++ };
			else res[lo + c] = { kind: 'new', orig: null };
		}
	};
	for (let c = 0; c < m; c++) {
		if (matchOfCur[c] === -1) continue;
		flush(c, matchOfCur[c]);
		res[lo + c] = { kind: 'same', orig: matchOfCur[c] };
		oPtr = matchOfCur[c] + 1;
		runStartC = c + 1;
	}
	flush(m, oEnd);
	return res;
}
