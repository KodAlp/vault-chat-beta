/**
 * Load-time safety gate for the WYSIWYG editor (pure, no DOM).
 *
 * A block may only be edited visually if re-serializing it cannot change what
 * the library viewer shows. "What the viewer shows" is decided by the viewer's
 * own pipeline: prepareMarkdown() (shared with markdown.ts) followed by the
 * same markdown-it configuration (html:false, linkify, the KaTeX plugin).
 * KaTeX itself is replaced by a stub that echoes the LaTeX source, so the
 * comparison is about the formula text and is fast (KaTeX per formula would
 * dominate on math-heavy notes). Shiki / DOMPurify / link attributes do not
 * depend on the Markdown text and are irrelevant to equality.
 */
import MarkdownIt from 'markdown-it';
import katexPlugin from '@vscode/markdown-it-katex';
import { prepareMarkdown } from '../markdown-prepare';

/** Notes above this size open in source mode: building the editor DOM for a
 * book-sized note takes many seconds (measured: 1.5 MB ~ 18 s). */
export const MAX_VISUAL_BYTES = 400 * 1024;
/** More locked blocks than this means the note is mostly unsuitable for visual editing. */
export const MAX_UNSAFE_BLOCKS = 10;

const echoKatex = {
	renderToString: (latex: string, opts: { displayMode?: boolean }) => `<m ${opts.displayMode ? 'D' : 'I'}>${latex}</m>`
};

const md = new MarkdownIt({ html: false, linkify: true });
// CJS package: Node/tsx expose the plugin as `.default`, Vite's interop hands it over directly.
const katex = ((katexPlugin as unknown as { default?: typeof katexPlugin }).default ?? katexPlugin) as typeof katexPlugin;
md.use(katex, { throwOnError: false, output: 'html', katex: echoKatex } as never);

/** Viewer HTML with KaTeX replaced by its LaTeX source. */
export function renderForCompare(markdown: string): string {
	return md.render(prepareMarkdown(markdown));
}

/** True when `reserialized` looks exactly like `original` in the viewer. */
export function isRoundTripSafe(original: string, reserialized: string): boolean {
	if (original === reserialized) return true;
	return renderForCompare(original) === renderForCompare(reserialized);
}

export type ModePlan = { mode: 'visual' } | { mode: 'source'; reason: 'too-large' | 'too-many-unsafe' };

/** Size check before any editor code is loaded. */
export function planBySize(bytes: number): ModePlan {
	return bytes > MAX_VISUAL_BYTES ? { mode: 'source', reason: 'too-large' } : { mode: 'visual' };
}

/** Final decision once the gate has counted the locked blocks. */
export function planByUnsafeCount(unsafeBlocks: number): ModePlan {
	return unsafeBlocks > MAX_UNSAFE_BLOCKS ? { mode: 'source', reason: 'too-many-unsafe' } : { mode: 'visual' };
}

/**
 * Round-trip equality is not enough for formulas: remark-math and the viewer's
 * markdown-it-katex disagree about where `$...$` starts and ends (currency like
 * "cost $5 and $6", a `\$` next to a `$`). The text would round-trip, yet the
 * editor would show a formula where the viewer shows prose. So the formulas the
 * editor parsed must be exactly the formulas the viewer finds, in order.
 */
export function mathSpansAgree(original: string, editorLatex: string[]): boolean {
	const viewer = [...renderForCompare(original).matchAll(/<m [DI]>([\s\S]*?)<\/m>/g)].map((m) => m[1].trim());
	if (viewer.length !== editorLatex.length) return false;
	return viewer.every((latex, i) => latex === editorLatex[i].trim());
}
