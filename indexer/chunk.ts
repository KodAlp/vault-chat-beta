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
}

const TARGET_CHARS = 1400; // ~350 tokens, chars/4 estimate
const HARD_MAX_CHARS = 2048; // ~512 tokens

type BlockType = 'code' | 'math' | 'text';
interface Block {
	type: BlockType;
	raw: string;
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
	return parts;
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
	while ((m = headingRe.exec(content))) {
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
			chunks.push({
				headingPath: section.headingPath,
				displayText,
				embedText: `[${topicLabel} | ${section.headingPath}] ${displayText}`
			});
			buffer = '';
		};

		for (const block of blocks) {
			if (block.type !== 'text') {
				if (buffer.length + block.raw.length > HARD_MAX_CHARS) flush();
				buffer += block.raw;
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
