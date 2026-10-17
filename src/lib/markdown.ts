import MarkdownIt from 'markdown-it';
import katexPlugin from '@vscode/markdown-it-katex';
import DOMPurify from 'dompurify';
import { createHighlighter, type Highlighter } from 'shiki';
import { ABSOLUTE_SRC_RE, resolveRelativeLibraryPath } from './attachment-link';
import { prepareMarkdown, normalizeMathDelimiters, hideMarkerComments } from './markdown-prepare';

const THEMES = { light: 'github-light', dark: 'github-dark' };
const LANGS = [
	'javascript',
	'typescript',
	'python',
	'c',
	'cpp',
	'rust',
	'bash',
	'json',
	'html',
	'css',
	'svelte',
	'sql',
	'asm'
];

const SANITIZE_OPTS = {
	ADD_TAGS: [
		'math',
		'semantics',
		'annotation',
		'annotation-xml',
		'mrow',
		'mi',
		'mo',
		'mn',
		'msup',
		'msub',
		'msubsup',
		'mfrac',
		'msqrt',
		'mroot',
		'mtable',
		'mtr',
		'mtd',
		'mspace',
		'mtext',
		'mstyle',
		'mpadded',
		'menclose'
	],
	ADD_ATTR: ['xmlns', 'display', 'mathvariant']
};

let highlighter: Highlighter | undefined;
let highlighterPromise: Promise<Highlighter> | undefined;

/** Lazy-loaded once at module scope, never per message — shiki init is expensive. */
function ensureHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({ themes: Object.values(THEMES), langs: LANGS }).then(
			(h) => (highlighter = h)
		);
	}
	return highlighterPromise;
}

const md: MarkdownIt = new MarkdownIt({
	html: false,
	linkify: true,
	highlight(code, lang) {
		if (highlighter && lang && highlighter.getLoadedLanguages().includes(lang)) {
			try {
				return highlighter.codeToHtml(code, { lang, themes: THEMES });
			} catch {
				// fall through to plain escaped output below
			}
		}
		return `<pre><code>${md.utils.escapeHtml(code)}</code></pre>`;
	}
});
md.use(katexPlugin, { throwOnError: false, output: 'html' });

/**
 * target="_blank" + rel="noopener noreferrer" on every generated link — the
 * plain-browser half of the "model links open inside the app with no way
 * back" fix (see openExternalLink.ts for the Tauri half, wired via a
 * document-level click listener in +layout.svelte since a markdown-it
 * render rule only produces a string of HTML, it can't attach a live
 * click handler with an isTauri() check at render time). Standard
 * markdown-it pattern: wrap the existing rule rather than replace it, so
 * whatever the base renderer already does with href/title is preserved.
 */
const defaultLinkOpenRenderer =
	md.renderer.rules.link_open ??
	((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
	tokens[idx].attrSet('target', '_blank');
	tokens[idx].attrSet('rel', 'noopener noreferrer');
	return defaultLinkOpenRenderer(tokens, idx, options, env, self);
};

/** Görsel B: lets the library viewer resolve a relative `![](...)` link
 * (as importObsidian.ts's rewriteEmbeds and, later, any docling attachment
 * copy write them) to the binary-serving route. `currentPath` is the
 * viewed file's own library-root-relative path — the same convention the
 * writer side uses when it computes a relative link via
 * `path.relative(dirname(currentRel), destRel)`. */
export interface MarkdownRenderContext {
	vaultId: string;
	currentPath: string;
}

const defaultImageRenderer =
	md.renderer.rules.image ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.image = (tokens, idx, options, env, self) => {
	const ctx = (env as { imgCtx?: MarkdownRenderContext } | undefined)?.imgCtx;
	const token = tokens[idx];
	const src = token.attrGet('src');
	if (ctx && src && !ABSOLUTE_SRC_RE.test(src)) {
		try {
			const resolved = resolveRelativeLibraryPath(ctx.currentPath, decodeURI(src));
			const params = new URLSearchParams({ path: resolved, vault: ctx.vaultId });
			token.attrSet('src', `/api/library/attachment?${params.toString()}`);
		} catch {
			// Malformed percent-encoding — leave src untouched, same as no ctx.
		}
	}
	return defaultImageRenderer(tokens, idx, options, env, self);
};

function countOccurrences(text: string, token: string): number {
	let count = 0;
	let idx = 0;
	while ((idx = text.indexOf(token, idx)) !== -1) {
		count++;
		idx += token.length;
	}
	return count;
}

/**
 * Truncates trailing incomplete `$$`/`$`/``` ``` ``` delimiters so an
 * in-flight streamed message never gets fed an unterminated math or code
 * block — that's what produces raw "$$" text or a KaTeX parse error mid-
 * stream. Only for messages still streaming; completed messages render the
 * untouched raw text so nothing is ever permanently truncated.
 */
export function stabilizeForStreaming(raw: string): string {
	// Normalize first — a half-streamed `\[` must not slip past the odd-count
	// check below just because it isn't `$$` yet.
	let text = normalizeMathDelimiters(raw);

	if (countOccurrences(text, '```') % 2 !== 0) {
		text += '\n```';
	}

	if (countOccurrences(text, '$$') % 2 !== 0) {
		text = text.slice(0, text.lastIndexOf('$$'));
	}

	// A lone unclosed `$` can only be on the last line at this point — any
	// earlier one would already have been part of a $$ pair caught above.
	const lastNewline = text.lastIndexOf('\n');
	const lastLine = text.slice(lastNewline + 1);
	if (countOccurrences(lastLine, '$') % 2 !== 0) {
		text = text.slice(0, lastNewline + 1 + lastLine.lastIndexOf('$'));
	}

	return text;
}

/**
 * The one exported render function, used by Message.svelte and nowhere else.
 * Pipeline order is load-bearing — do not reorder:
 * protect code -> normalize math delimiters -> repair unbalanced braces ->
 * restore code -> markdown-it parse (KaTeX + shiki run inside the parse via
 * plugin/highlight hook) -> sanitize.
 *
 * Callers rendering an in-flight streamed message must pre-process with
 * `stabilizeForStreaming()` first; this function itself only normalizes
 * delimiters and repairs brace balance, it does not guard against
 * unterminated $/$$/``` delimiters.
 *
 * `ctx` is optional and only meaningful for the library viewer (see
 * MarkdownRenderContext) — chat messages have no "current file" to resolve
 * a relative image link against, so Message.svelte omits it and relative
 * `![](...)` src attributes are left untouched there.
 */
export async function renderMarkdown(raw: string, ctx?: MarkdownRenderContext): Promise<string> {
	await ensureHighlighter();
	const restored = prepareMarkdown(hideMarkerComments(raw));
	const html = md.render(restored, ctx ? { imgCtx: ctx } : undefined);
	return DOMPurify.sanitize(html, SANITIZE_OPTS);
}
