import matter from 'gray-matter';

export interface RawChunk {
	headingPath: string;
	displayText: string;
	embedText: string;
}

export interface Frontmatter {
	// Real schema per CLAUDE.md invariant 2 (wiki pages).
	title?: string;
	domain?: string;
	level?: string;
	status?: string;
	// Fallback aliases some notes/imported content may use instead.
	topic?: string;
	domains?: string[];
	depth?: string;
	/** Raw YAML value, whatever shape it has (a list of wikilinks, a nested list, a string) —
	 * indexer/prerequisites.ts turns it into note names. */
	prerequisites?: unknown;
}

const TARGET_CHARS = 1400; // ~350 tokens, chars/4 estimate
/** Exported so chunk.test.ts asserts against the real budget instead of a
 * copy that could drift from it — same reasoning as skill-limits.ts. */
export const HARD_MAX_CHARS = 2048; // ~512 tokens

/**
 * CLAUDE.md invariant 2 asks for exactly `undergrad | grad | phd`, but
 * frontmatter is hand-written and both index-vault.ts and
 * incrementalIndex.ts independently fell back to `frontmatter.depth` for
 * content that used that alias instead — the real index ended up holding
 * "undergrad" (121 chunks) and "undergraduate" (27) as two different level
 * values. select-chunks.ts's level filter already matches case-insensitively
 * for exactly this kind of drift; this closes the other half by folding
 * known synonyms to the canonical spelling before a file row is ever
 * written, so the two index-writing paths can't drift apart again.
 */
const LEVEL_SYNONYMS: Record<string, string> = {
	undergraduate: 'undergrad',
	graduate: 'grad',
	doctorate: 'phd',
	doctoral: 'phd'
};

/**
 * Typed `string` in Frontmatter, but frontmatter is hand-written YAML parsed
 * by gray-matter with no runtime schema check — `level: 3` or `level: [a]`
 * parses fine and reaches this function as a number or array. Before this
 * guard, `level.trim()` threw `TypeError: level.trim is not a function` and
 * aborted the whole indexing run partway through a directory walk: two files
 * after the bad one (alphabetically) were silently never indexed (Ö2).
 */
export function normalizeLevel(level: unknown): string {
	if (typeof level !== 'string') return '';
	const trimmed = level.trim();
	if (!trimmed) return trimmed;
	return LEVEL_SYNONYMS[trimmed.toLowerCase()] ?? trimmed;
}

type BlockType = 'code' | 'math' | 'text';
interface Block {
	type: BlockType;
	raw: string;
}

/** Replaces a span with spaces, keeping every newline, so a later regex that
 * scans the masked copy still reports character offsets valid into the
 * original (unmasked) string. */
function blankSpan(text: string, start: number, end: number): string {
	return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, ' ') + text.slice(end);
}

/**
 * A copy of `content` with fenced code and $$ blocks blanked out, for the
 * heading scan below to search without matching inside them.
 *
 * Ö3: `## ` is a common comment marker in Python/shell. Before this mask, a
 * `## not a heading` comment line inside a fenced code block was scanned as
 * a real section break — the code block was split in two mid-block, and the
 * second half's headingPath literally contained the comment text.
 */
function maskAtomicBlocksForHeadingScan(content: string): string {
	let masked = content;
	const re = /```[\s\S]*?```|\$\$[\s\S]*?\$\$/;
	let match: RegExpMatchArray | null;
	while ((match = masked.match(re))) {
		masked = blankSpan(masked, match.index!, match.index! + match[0].length);
	}
	return masked;
}

/** Pulls out fenced code / $$ blocks as atomic units so paragraph-splitting never lands inside one. */
function splitAtomicBlocks(body: string): Block[] {
	const blocks: Block[] = [];
	const re = /(```[\s\S]*?```|\$\$[\s\S]*?\$\$)/g;
	let last = 0;
	let match: RegExpExecArray | null;
	while ((match = re.exec(body))) {
		if (match.index > last) blocks.push({ type: 'text', raw: body.slice(last, match.index) });
		blocks.push({ type: match[0].startsWith('```') ? 'code' : 'math', raw: match[0] });
		last = match.index + match[0].length;
	}
	if (last < body.length) blocks.push({ type: 'text', raw: body.slice(last) });
	return blocks;
}

/**
 * Last-resort splitter: HARD_MAX_CHARS was an intention, not a guarantee.
 * Paragraph splitting needs blank lines, and a PDF→markdown conversion is
 * routinely one unbroken run of text with none — so a single source file
 * produced a single 1.449.838-char chunk, which then went to the model as
 * ~362k tokens and blew every cloud provider's context window (observed:
 * OpenRouter "you requested about 385182 tokens", Groq "please reduce the
 * length of the messages"). Only became reachable once large PDFs could
 * actually be imported, i.e. after the BODY_SIZE_LIMIT fix.
 *
 * Breaks on a newline if there is one late in the window, then on a space,
 * and only cuts mid-token when the text offers nothing else (minified JSON,
 * a base64 blob). The 0.75 floor keeps a split from leaving a uselessly
 * short fragment behind.
 */
function hardSplit(text: string, maxChars: number = HARD_MAX_CHARS): string[] {
	if (text.length <= maxChars) return [text];
	const minCut = Math.floor(maxChars * 0.75);
	const parts: string[] = [];
	let rest = text;
	while (rest.length > maxChars) {
		const window = rest.slice(0, maxChars);
		let cut = window.lastIndexOf('\n');
		if (cut < minCut) cut = window.lastIndexOf(' ');
		if (cut < minCut) cut = maxChars;
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\s+/, '');
	}
	if (rest) parts.push(rest);
	return parts;
}

/**
 * Splits `body` into <= maxChars pieces without ever cutting a line, and
 * without touching whitespace at the start of the line that begins the next
 * piece — unlike hardSplit(), which strips leading whitespace off the
 * continuation (fine for prose, but would silently de-indent Python or any
 * other whitespace-significant code at every split point).
 *
 * Falls back to hardSplit's own space/hard-cut behavior only for a single
 * line that alone exceeds maxChars (minified code, a base64 blob) — never
 * for a clean multi-line piece.
 */
function splitLinesPreservingWhitespace(body: string, maxChars: number): string[] {
	const lines = body.split('\n');
	const pieces: string[] = [];
	let current = '';
	for (const line of lines) {
		const candidate = current ? `${current}\n${line}` : line;
		if (candidate.length <= maxChars) {
			current = candidate;
			continue;
		}
		if (current) {
			pieces.push(current);
			current = '';
		}
		if (line.length <= maxChars) {
			current = line;
		} else {
			const forced = hardSplit(line, maxChars);
			pieces.push(...forced.slice(0, -1));
			current = forced[forced.length - 1];
		}
	}
	if (current) pieces.push(current);
	return pieces;
}

/** Strips a code or math block down to its wrapper (fence marker + info
 * string, or `$$`) and inner body, so the body alone can be measured and
 * split without the wrapper counting against its own budget. */
function unwrapAtomicBlock(block: Block): { open: string; body: string; close: string } {
	if (block.type === 'code') {
		const m = /^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n?\1[ \t]*$/.exec(block.raw);
		if (m) return { open: `${m[1]}${m[2]}\n`, body: m[3], close: `\n${m[1]}` };
		return { open: '', body: block.raw, close: '' }; // malformed fence, shouldn't happen
	}
	const inner = block.raw.slice(2, -2).replace(/^\n/, '').replace(/\n$/, '');
	return { open: '$$\n', body: inner, close: '\n$$' };
}

/**
 * Splits an oversized fenced code or $$ math block into HARD_MAX_CHARS
 * pieces, each individually re-wrapped in the same fence/delimiter — never a
 * bare mid-block slice.
 *
 * Ö4: the chunker used to run plain hardSplit() over block.raw as a whole.
 * That cuts on the block's own text without any notion of the wrapper, so
 * only the first piece kept the opening ``` / $$ and only the last kept the
 * closing one — a 150-line C block over budget became one real fenced block
 * followed by unfenced plain-text fragments. "Code blocks are atomic" was
 * only true below 2048 characters.
 */
function splitAtomicBlockPreserving(block: Block): string[] {
	if (block.raw.length <= HARD_MAX_CHARS) return [block.raw];
	const { open, body, close } = unwrapAtomicBlock(block);
	if (!open) return hardSplit(block.raw); // malformed fence: fall back rather than crash
	const budget = Math.max(HARD_MAX_CHARS - open.length - close.length, 1);
	return splitLinesPreservingWhitespace(body, budget).map((piece) => `${open}${piece}${close}`);
}

function splitOnParagraphs(text: string): string[] {
	if (text.length <= HARD_MAX_CHARS) return [text];
	const paragraphs = text.split(/\n{2,}/);
	const parts: string[] = [];
	let current = '';
	for (const p of paragraphs) {
		if (current && current.length + p.length > TARGET_CHARS) {
			parts.push(current);
			current = p;
		} else {
			current = current ? `${current}\n\n${p}` : p;
		}
	}
	if (current) parts.push(current);
	// A single paragraph can still exceed HARD_MAX_CHARS on its own — that is
	// exactly the case this whole function used to miss. Wrapped in an arrow,
	// not passed bare: flatMap calls its callback with (value, index, array),
	// and hardSplit's now-optional second parameter would silently receive
	// the paragraph's array index as maxChars instead of the default budget.
	return parts.flatMap((p) => hardSplit(p));
}

/**
 * A section that only points at other notes is navigation, not knowledge.
 *
 * Every wiki page ends with a `## Sources` (and often `## Related`) section
 * that is nothing but a list of links. Indexed as ordinary chunks these were
 * 287 of 2442 chunks in the real index — 11.8% overall, 15.5% of wiki/math —
 * averaging 126 chars against 1049 for genuine content. Because they are short
 * and literally contain the word "Sources", any question phrased *about*
 * sources or access ("matematik kaynağı işaretli, erişemiyor musun?") matched
 * them ahead of the notes themselves and consumed all k slots, leaving the
 * model with a context of bare link lists and nothing to explain. It then
 * correctly reported that the content was not there.
 *
 * The link targets are not lost: they live in the page's own frontmatter and
 * in the MOC layer, neither of which is a retrieval surface.
 */
const LINK_ONLY_LINE = /^[-*+]\s*\[\[[^\]]+\]\]\s*$|^[-*+]\s*\[[^\]]*\]\([^)]*\)\s*$/;
const NAV_LINE_RATIO = 0.7;

function isNavigationOnly(displayText: string): boolean {
	const body = displayText
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.filter((l) => !/^#{1,6}\s/.test(l));
	// A heading with no body at all is a bare breadcrumb — nothing to retrieve.
	if (body.length === 0) return true;
	const linkOnly = body.filter((l) => LINK_ONLY_LINE.test(l)).length;
	return linkOnly / body.length >= NAV_LINE_RATIO;
}

interface HeadingMatch {
	level: number;
	title: string;
	index: number;
}

function findHeadingPath(topicLabel: string, matches: HeadingMatch[], i: number, stack: string[]): string {
	const m = matches[i];
	const depth = m.level - 2; // level 2 (##) -> depth 0
	stack.length = depth;
	stack[depth] = m.title;
	return [topicLabel, ...stack.slice(0, depth + 1)].filter(Boolean).join(' > ');
}

/**
 * Splits a wiki page into retrieval chunks: sectioned by ## and deeper headings,
 * each carrying its full breadcrumb, target 200-400 tokens with a 512 hard cap,
 * never splitting inside fenced code or $$ math blocks (see vault-rag-index skill).
 */
export function chunkMarkdown(rawFile: string): { frontmatter: Frontmatter; chunks: RawChunk[] } {
	const { data, content } = matter(rawFile);
	const frontmatter = data as Frontmatter;
	const topicLabel = frontmatter.title ?? frontmatter.topic ?? '';

	const headingRe = /^(#{2,6})\s+(.+)$/gm;
	const matches: HeadingMatch[] = [];
	let m: RegExpExecArray | null;
	const headingScanTarget = maskAtomicBlocksForHeadingScan(content);
	while ((m = headingRe.exec(headingScanTarget))) {
		matches.push({ level: m[1].length, title: m[2].trim(), index: m.index });
	}

	const sections: { headingPath: string; body: string }[] = [];
	const stack: string[] = [];
	if (matches.length === 0) {
		sections.push({ headingPath: topicLabel, body: content.trim() });
	} else {
		if (matches[0].index > 0) {
			sections.push({ headingPath: topicLabel, body: content.slice(0, matches[0].index).trim() });
		}
		for (let i = 0; i < matches.length; i++) {
			const headingPath = findHeadingPath(topicLabel, matches, i, stack);
			const start = matches[i].index;
			const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
			sections.push({ headingPath, body: content.slice(start, end).trim() });
		}
	}

	const chunks: RawChunk[] = [];
	for (const section of sections) {
		if (!section.body) continue;
		const blocks = splitAtomicBlocks(section.body);

		let buffer = '';
		const flush = () => {
			const displayText = buffer.trim();
			if (!displayText) return;
			if (isNavigationOnly(displayText)) {
				buffer = '';
				return;
			}
			chunks.push({
				headingPath: section.headingPath,
				displayText,
				embedText: `[${topicLabel} | ${section.headingPath}] ${displayText}`
			});
			buffer = '';
		};

		for (const block of blocks) {
			if (block.type !== 'text') {
				// splitAtomicBlockPreserving, not a bare `buffer += block.raw`: a
				// fenced code or math block was appended whole regardless of size,
				// so one huge block became one huge chunk — the same failure
				// splitOnParagraphs had, by a different route. Each returned piece
				// is itself a complete, re-fenced block (Ö4).
				for (const piece of splitAtomicBlockPreserving(block)) {
					if (buffer.length + piece.length > HARD_MAX_CHARS) flush();
					buffer += piece;
				}
				continue;
			}
			for (const piece of splitOnParagraphs(block.raw)) {
				if (buffer.length + piece.length > TARGET_CHARS && buffer.length > 0) flush();
				buffer += piece;
			}
		}
		flush();
	}

	return { frontmatter, chunks };
}
