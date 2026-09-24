import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarpDeck, createSlidesMarp } from './slides-deck';
import { SLIDE_LAYOUTS } from './slides-schema';

test('buildMarpDeck emits the theme name, a local _class directive and the heading for every slide', () => {
	const deck = buildMarpDeck([
		{ layout: 'title', heading: 'Başlık', content_markdown: 'Alt başlık' },
		{ layout: 'bullets', heading: 'İkinci', content_markdown: '- a\n- b' }
	]);
	assert.match(deck, /^---\nmarp: true\ntheme: vault-observatory\n---\n\n/);
	assert.match(deck, /<!-- _class: title -->\n\n# Başlık\n\nAlt başlık/);
	assert.match(deck, /<!-- _class: bullets -->\n\n# İkinci\n\n- a\n- b/);
	// A real "\n\n---\n\n" separator between the 2 slides (1 separator ->
	// 2 pieces) — not string-interpolated in a way that could fold a
	// slide's trailing content into the separator line.
	assert.equal(deck.split('\n\n---\n\n').length, 2);
});

test('a heading is not duplicated into the body — content_markdown alone has no leading "# "', () => {
	const deck = buildMarpDeck([{ layout: 'quote', heading: 'X', content_markdown: '> alıntı' }]);
	// Exactly one "# " heading line (the one buildMarpDeck itself adds).
	const headingLines = deck.split('\n').filter((l) => l.startsWith('# '));
	assert.equal(headingLines.length, 1);
});

test('inline math delimiter whitespace is trimmed (marp-core/katex requires no interior padding)', () => {
	const deck = buildMarpDeck([{ layout: 'bullets', heading: 'H', content_markdown: 'değer $ x^2 $ burada' }]);
	assert.match(deck, /\$x\^2\$/);
	assert.doesNotMatch(deck, /\$ x\^2 \$/);
});

// The end-to-end proof the plan's own acceptance criterion (docs/plan-ogrenme-ajani-ve-performans.md
// §7, F13) asks for: "üretilen deck'te layout çeşitliliği görünmeli, Marp render'ı hata vermemeli,
// $...$ matematik hâlâ KaTeX ile çizilmeli" — run through the REAL @marp-team/marp-core renderer with
// this app's real theme, not just checked as a markdown string.
test('every SLIDE_LAYOUTS value renders via the real Marp/theme pipeline without throwing, with a distinct section class and working KaTeX', () => {
	const slides = SLIDE_LAYOUTS.map((layout, i) => ({
		layout,
		heading: `Slayt ${i + 1}`,
		content_markdown: layout === 'quote' ? '> $x^2$ tanımı' : `İçerik $x^2$ ${layout}`
	}));
	const deck = buildMarpDeck(slides);

	const marp = createSlidesMarp();
	const { html } = marp.render(deck); // must not throw

	for (const layout of SLIDE_LAYOUTS) {
		assert.match(html, new RegExp(`class="${layout}"`), `no section rendered with class="${layout}"`);
	}
	// KaTeX actually ran (not just left as literal "$x^2$" text) — every
	// slide's math should have produced real katex markup.
	const katexMatches = html.match(/class="katex"/g) ?? [];
	assert.equal(katexMatches.length, SLIDE_LAYOUTS.length);
	assert.doesNotMatch(html, /\$x\^2\$/);
});

test('a diagram layout with valid node/edge data renders the deterministic SVG through the real Marp pipeline (F13-3)', () => {
	const deck = buildMarpDeck([
		{
			layout: 'diagram',
			heading: 'Süreç',
			content_markdown: '- yedek madde listesi (diyagram yoksa gösterilir)',
			diagram: {
				nodes: [
					{ id: 'n1', label: 'İstek gelir' },
					{ id: 'n2', label: 'İşlenir' },
					{ id: 'n3', label: 'Yanıt döner' }
				],
				edges: [
					{ from: 'n1', to: 'n2' },
					{ from: 'n2', to: 'n3', label: 'başarılı' }
				]
			}
		}
	]);
	// The rendered SVG replaced content_markdown entirely for this slide —
	// the fallback bullet text must NOT leak into the deck alongside it.
	assert.doesNotMatch(deck, /yedek madde listesi/);
	assert.match(deck, /<svg /);
	assert.match(deck, /İstek gelir/);

	const marp = createSlidesMarp();
	const { html } = marp.render(deck); // must not throw
	assert.match(html, /class="diagram"/);

	// Regression guard for the real bug found by a live Ollama trial
	// (2026-09-24, Bulgu 3 ek notu): marp-core's default `html` allowlist has
	// no svg/rect/text/... entries at all, so WITHOUT createSlidesMarp()'s
	// merged allowlist the whole thing gets HTML-escaped into visible
	// "&lt;svg..." text instead of rendering — `/<svg /` alone is not a
	// strong enough assertion, because marp-core's OWN unrelated bundled
	// script also contains the literal substring "<svg " elsewhere in the
	// full page, which let that false pass slip through the first time.
	assert.doesNotMatch(html, /&lt;svg/, 'diagram SVG was HTML-escaped instead of rendered');
	// Our exact svg signature (width/height/role/aria-label — see
	// slides-diagram.ts, no viewBox/marker: both would be lowercased by
	// marp-core's xss filter and stop working), followed immediately by a
	// real <rect>, not escaped text.
	assert.match(html, /<svg width="\d+" height="\d+" role="img" aria-label="diagram"[^>]*>(?:(?!<\/svg>)[\s\S])*<rect /);
	assert.match(html, /<text[^>]*>İstek gelir<\/text>/);
	// Every edge's arrowhead is a hand-drawn <polygon>, not an SVG <marker>
	// (also lowercased into brokenness by the same filter).
	assert.match(html, /<polygon points="[^"]+" fill="oklch\(76% 0\.17 155\)"\s*\/>/);
	assert.doesNotMatch(html, /<marker /);
});

test('two edges sharing the same directed (from, to) pair are offset apart, not drawn on top of each other', () => {
	// Found by the same live trial: a real TCP-handshake generation produced
	// two separate n1->n2 edges (SYN, then ACK) alongside a n2->n1 reply —
	// without a lane offset both n1->n2 lines render at the exact same x,
	// overlapping completely and hiding one label behind the other.
	const svg = buildMarpDeck([
		{
			layout: 'diagram',
			heading: 'H',
			content_markdown: '-',
			diagram: {
				nodes: [
					{ id: 'n1', label: 'A' },
					{ id: 'n2', label: 'B' }
				],
				edges: [
					{ from: 'n1', to: 'n2', label: 'SYN' },
					{ from: 'n1', to: 'n2', label: 'ACK' }
				]
			}
		}
	]);
	const lineXs = [...svg.matchAll(/<line x1="(\d+)"/g)].map((m) => m[1]);
	assert.equal(lineXs.length, 2);
	assert.notEqual(lineXs[0], lineXs[1], 'both n1->n2 edges drew at the same x — they overlap');
});

test('a diagram layout with no diagram data falls back to content_markdown untouched', () => {
	const deck = buildMarpDeck([{ layout: 'diagram', heading: 'Süreç', content_markdown: '- adım 1\n- adım 2' }]);
	assert.match(deck, /- adım 1\n- adım 2/);
	assert.doesNotMatch(deck, /<svg /);
});

test('a diagram layout with only-invalid edges (unknown ids) falls back to content_markdown, not an empty SVG', () => {
	const deck = buildMarpDeck([
		{
			layout: 'diagram',
			heading: 'Süreç',
			content_markdown: '- yedek',
			diagram: { nodes: [], edges: [{ from: 'ghost1', to: 'ghost2' }] }
		}
	]);
	assert.match(deck, /- yedek/);
	assert.doesNotMatch(deck, /<svg /);
});
