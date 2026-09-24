/**
 * F13-2 (Aşama 9) — a Marpit theme CSS string, registered once per
 * generateSlides() call via `marp.themeSet.add(SLIDES_THEME_CSS)` and
 * selected by name in buildMarpDeck()'s frontmatter (`theme: <name>`).
 * Before this, `buildMarpDeck`'s header was just `marp: true` — no theme,
 * no fonts, no layout classes — rendered with marp-core's plain default.
 *
 * Ports DESIGN.md's dark-observatory palette/typography into a
 * self-contained document: the rendered deck is displayed inside a
 * sandboxed `<iframe sandbox="" srcdoc="...">` (see
 * study/slides/[id]/+page.svelte) which shares no CSS or fonts with the
 * parent app — every color is a literal `oklch()` value copied from
 * DESIGN.md, and fonts are `@font-face`d here again from the same
 * self-hosted `/fonts/*.woff2` files app.css already loads (a `srcdoc`
 * iframe's document base URL is the PARENT page's URL, so an absolute
 * `/fonts/...` path resolves to the same origin; `sandbox=""` blocks
 * scripting/navigation, not subresource fetches like fonts, so this
 * works without `allow-same-origin`).
 *
 * `@auto-scaling true` (marp-core's own overflow-shrinking feature,
 * present in its bundled default/gaia/uncover themes) is deliberately
 * NOT enabled — it relies on a custom-element web component that upgrades
 * via JavaScript, and the display iframe above has no `allow-scripts`;
 * enabling it would risk shipping inert, half-upgraded markup instead of
 * a working fallback. Long content is handled by generous slide padding
 * and the prompt's own bullet-count guidance instead.
 */

export const SLIDES_THEME_NAME = 'vault-observatory';

// Same latin/latin-ext @font-face pairs as app.css, so slide text (including
// Turkish Ş/ş/Ğ/ğ, carried by latin-ext) matches the rest of the app exactly.
const FONT_FACES = `
@font-face {
	font-family: 'Fraunces';
	font-style: normal;
	font-weight: 480;
	src: url('/fonts/fraunces-480-latin.woff2') format('woff2');
	unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122;
}
@font-face {
	font-family: 'Fraunces';
	font-style: normal;
	font-weight: 480;
	src: url('/fonts/fraunces-480-latin-ext.woff2') format('woff2');
	unicode-range: U+0100-024F, U+0300-0301, U+0303-0304, U+0308-0309, U+1E00-1EFF;
}
@font-face {
	font-family: 'Schibsted Grotesk';
	font-style: normal;
	font-weight: 400;
	src: url('/fonts/schibsted-grotesk-400-latin.woff2') format('woff2');
	unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122;
}
@font-face {
	font-family: 'Schibsted Grotesk';
	font-style: normal;
	font-weight: 400;
	src: url('/fonts/schibsted-grotesk-400-latin-ext.woff2') format('woff2');
	unicode-range: U+0100-024F, U+0300-0301, U+0303-0304, U+0308-0309, U+1E00-1EFF;
}
@font-face {
	font-family: 'Schibsted Grotesk';
	font-style: normal;
	font-weight: 600;
	src: url('/fonts/schibsted-grotesk-600-latin.woff2') format('woff2');
	unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122;
}
@font-face {
	font-family: 'Schibsted Grotesk';
	font-style: normal;
	font-weight: 600;
	src: url('/fonts/schibsted-grotesk-600-latin-ext.woff2') format('woff2');
	unicode-range: U+0100-024F, U+0300-0301, U+0303-0304, U+0308-0309, U+1E00-1EFF;
}
@font-face {
	font-family: 'IBM Plex Mono';
	font-style: normal;
	font-weight: 400;
	src: url('/fonts/ibm-plex-mono-400-latin.woff2') format('woff2');
	unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122;
}
@font-face {
	font-family: 'IBM Plex Mono';
	font-style: normal;
	font-weight: 400;
	src: url('/fonts/ibm-plex-mono-400-latin-ext.woff2') format('woff2');
	unicode-range: U+0100-024F, U+0300-0301, U+0303-0304, U+0308-0309, U+1E00-1EFF;
}
`;

export const SLIDES_THEME_CSS = `/* @theme ${SLIDES_THEME_NAME} */
${FONT_FACES}
section {
	/* Marpit's own postcss section-size plugin reads width/height straight
	   off this rule, not off an at-size meta comment (that comment style,
	   seen in marp-core's bundled themes, feeds a different, marp-core-only
	   switchable-aspect-ratio feature this theme doesn't opt into) — this is
	   what makes theme.widthPixel/heightPixel, and the actual rendered SVG
	   viewBox, come out to 16:9 instead of Marpit's 4:3 fallback. */
	width: 1280px;
	height: 720px;
	background: oklch(13% 0.008 165);
	color: oklch(93% 0.004 165);
	font-family: 'Schibsted Grotesk', 'Instrument Sans', sans-serif;
	font-size: 30px;
	line-height: 1.5;
	padding: 64px 76px;
	display: flex;
	flex-direction: column;
	justify-content: center;
	gap: 20px;
	box-sizing: border-box;
}

section h1 {
	font-family: 'Fraunces', Georgia, serif;
	font-weight: 480;
	letter-spacing: -0.015em;
	font-size: 52px;
	line-height: 1.15;
	color: oklch(93% 0.004 165);
	margin: 0;
}

section p {
	margin: 0;
}

section ul,
section ol {
	margin: 0;
	padding-left: 1.1em;
}

section li {
	margin: 0.3em 0;
}

section strong {
	color: oklch(82% 0.13 155);
	font-weight: 600;
}

section a {
	color: oklch(82% 0.13 155);
}

section code {
	font-family: 'IBM Plex Mono', ui-monospace, monospace;
	background: oklch(90% 0 0 / 0.08);
	border-radius: 4px;
	padding: 0.1em 0.35em;
}

section pre {
	background: oklch(9% 0.006 165);
	border: 1px solid oklch(90% 0 0 / 0.08);
	border-radius: 10px;
	padding: 20px 24px;
	overflow: auto;
}

section pre code {
	background: none;
	padding: 0;
}

section blockquote {
	margin: 0;
	border-left: 3px solid oklch(76% 0.17 155 / 0.45);
	padding-left: 28px;
	color: oklch(62% 0.008 165);
}

/* layout: title — opening/section-break slide, centered on a deeper ground */
section.title {
	background: oklch(9% 0.006 165);
	align-items: center;
	text-align: center;
}
section.title h1 {
	font-size: 68px;
}

/* layout: bullets — the default; the base "section" rules above already cover it. */

/* layout: two-column — plain CSS multi-column flow (Marpit has no built-in
   column directive), a deliberately simple approximation of a real
   left/right split. */
section.two-column ul,
section.two-column ol,
section.two-column p {
	columns: 2;
	column-gap: 48px;
}

/* layout: quote — a single pulled quote, no bullets expected. */
section.quote {
	align-items: center;
	text-align: center;
}
section.quote blockquote {
	border-left: none;
	font-family: 'Fraunces', Georgia, serif;
	font-weight: 480;
	font-size: 38px;
	line-height: 1.3;
	color: oklch(93% 0.004 165);
	padding: 0 40px;
}

/* layout: diagram — F13-3 (Aşama 11): the section centers the deterministic
   inline SVG slides-diagram.ts renders (or, when the model didn't produce a
   valid node/edge structure and generate-slides.ts fell back to plain text,
   whatever markdown ended up in content_markdown instead). */
section.diagram {
	align-items: center;
	text-align: center;
}
section.diagram svg {
	max-width: 100%;
	max-height: 460px;
}

/* layout: code — mostly a fenced code block; the heading needs less room. */
section.code h1 {
	font-size: 38px;
}
`;
