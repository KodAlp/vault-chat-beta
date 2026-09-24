import { Marp } from '@marp-team/marp-core';
import { SLIDES_THEME_NAME, SLIDES_THEME_CSS } from './slides-theme';
import { isRenderableDiagram, renderDiagramSvg, SLIDE_DIAGRAM_HTML_ALLOWLIST, type DiagramSpec } from './slides-diagram';

/**
 * F13-1/2 (Aşama 9): pulled out of generate-slides.ts into its own module —
 * that file imports `chatWithFallback` from `./providers/registry`, which
 * itself imports SvelteKit's `$env/dynamic/private` (a Vite virtual module).
 * That makes generate-slides.ts unimportable from plain `tsx --test` (this
 * project's actual test runner, no Vite involved) the same way mcp/ needed
 * env.ts as a Vite-free shim — so `buildMarpDeck`, the one genuinely pure
 * piece of that file, gets its own `*.test.ts` here instead of staying
 * untestable inside it.
 */

const INLINE_MATH_RE = /\$\$([\s\S]*?)\$\$|\$([^$\n]+?)\$/g;

/**
 * marp-core's bundled KaTeX plugin (a different implementation from this
 * app's own @vscode/markdown-it-katex, used by markdown.ts for report/chat)
 * requires NO whitespace immediately inside inline `$...$` delimiters to
 * recognize them as math — `$x^2$` renders, `$ x^2 $` silently falls through
 * as literal text. Verified empirically against the real package: block
 * `$$...$$` tolerates interior spaces fine, only inline is strict. Local
 * models (qwen3:8b observed in practice) routinely pad both sides with a
 * space, so this trim is load-bearing, not defensive — without it, math in
 * slides silently renders as raw dollar-sign text with no error anywhere.
 */
function trimMathDelimiterWhitespace(text: string): string {
	return text.replace(INLINE_MATH_RE, (full, display: string | undefined, inline: string | undefined) => {
		if (display !== undefined) return `$$${display.trim()}$$`;
		if (inline !== undefined) return `$${inline.trim()}$`;
		return full;
	});
}

export interface DeckSlide {
	layout: string;
	heading: string;
	content_markdown: string;
	/** F13-3 (Aşama 11) — only consulted when layout === 'diagram'. Missing
	 * or, after sanitizing, empty (isRenderableDiagram false) falls back to
	 * content_markdown untouched, same graceful-degradation stance as
	 * mindmap-validate.ts's soft checks: a provider/model that skips this
	 * field still produces a usable slide, just without the drawing. */
	diagram?: DiagramSpec;
}

/** Marpit's slide separator ("\n---\n" between blank lines) requires the
 * concatenated deck to be built with real newlines, not string interpolation
 * that could accidentally merge a slide's trailing content into the next
 * separator line.
 *
 * F13-1/2 (Aşama 9): each slide gets a `<!-- _class: layout -->` LOCAL
 * directive (underscore prefix — current slide only, per Marpit's directive
 * rules; a global `class:` would leak onto every following slide) selecting
 * one of slides-theme.ts's `.{layout}` selectors, then its own `# heading`
 * line reconstructed from the now-separate `heading` field (the model no
 * longer writes the heading INTO content_markdown — see
 * generate-slides.ts's buildSystemPrompt invariant on that). */
export function buildMarpDeck(slides: DeckSlide[]): string {
	const header = `---\nmarp: true\ntheme: ${SLIDES_THEME_NAME}\n---\n\n`;
	const body = slides
		.map((s) => {
			const useDiagram = s.layout === 'diagram' && s.diagram && isRenderableDiagram(s.diagram);
			const content = useDiagram
				? renderDiagramSvg(s.diagram!)
				: trimMathDelimiterWhitespace(s.content_markdown.trim());
			return `<!-- _class: ${s.layout} -->\n\n# ${s.heading}\n\n${content}`;
		})
		.join('\n\n---\n\n');
	return header + body;
}

/**
 * A fresh `Marp` instance, themed and configured — the one place that
 * constructs one, so generate-slides.ts and every test stay in sync on both
 * the theme registration and (F13-3, Aşama 11) the custom `html` allowlist
 * that lets the `diagram` layout's SVG through without being escaped. See
 * slides-diagram.ts's module doc comment for why `Marp.html`'s own 71-tag
 * default has no `svg`/`rect`/... entries at all, and why the merge here
 * must never be replaced with a bare `html: true` (that would stop
 * filtering EVERY layout's content_markdown, not just this one template).
 */
export function createSlidesMarp(): Marp {
	const marp = new Marp({
		math: 'katex',
		html: { ...Marp.html, ...SLIDE_DIAGRAM_HTML_ALLOWLIST }
	});
	marp.themeSet.add(SLIDES_THEME_CSS);
	return marp;
}
