import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Marp } from '@marp-team/marp-core';
import { buildMarpDeck } from './slides-deck';
import { SLIDES_THEME_CSS } from './slides-theme';
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

	const marp = new Marp({ math: 'katex' });
	marp.themeSet.add(SLIDES_THEME_CSS);
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
