import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { buildMarpDeck, createSlidesMarp, type DeckSlide } from './slides-deck';
import { Slides } from './slides-schema';

/**
 * "quote" and "two-column" were never exercised with realistic content.
 * Both layouts are plain Markdown + a theme `.{layout}` class (there is no
 * left/right schema field): quote = a `>` blockquote, two-column = a list /
 * paragraph flowed by CSS multi-column. These fixtures go through the real
 * Marp pipeline, no model.
 */

const LONG_QUOTE =
	'> "Bir fonksiyonun bir noktada türevlenebilir olması, o noktada sürekli olması için yeterli değil, ' +
	'ancak gerekli bir koşuldur; yani her türevlenebilir fonksiyon süreklidir, fakat her sürekli fonksiyon ' +
	'türevlenebilir olmak zorunda değildir. Mutlak değer fonksiyonu bunun en bilinen örneğidir."\n>\n> — Ders Notu, Bölüm 3.2';

export const FIXTURES: DeckSlide[] = [
	{ layout: 'title', heading: 'Kapak', content_markdown: 'Alıntı ve iki sütun denemesi' },
	{ layout: 'quote', heading: 'Uzun alıntı', content_markdown: LONG_QUOTE },
	{ layout: 'quote', heading: 'Kısa alıntı', content_markdown: '> Sonsuzluk bir sınırdır.' },
	{
		layout: 'quote',
		heading: 'Türkçe & matematik',
		content_markdown: '> "Şu özdeşlik çok önemli: $E=mc^2$ — ığdır, İstanbul, ÖĞÜŞÇ."\n> — Albert Einstein'
	},
	{ layout: 'quote', heading: 'Atıfsız', content_markdown: '> Sadece alıntı, atıf yok.' },
	{
		layout: 'two-column',
		heading: 'Dengeli',
		content_markdown:
			'- Birinci madde\n- İkinci madde\n- Üçüncü madde\n- Dördüncü madde\n- Beşinci madde\n- Altıncı madde'
	},
	{
		layout: 'two-column',
		heading: 'Dengesiz',
		content_markdown:
			'- ' +
			'Uzun bir madde, birkaç satıra yayılacak kadar ayrıntılı bir açıklama içeriyor ve sütun genişliğinde sarılmalı. '.repeat(3) +
			'\n- Kısa'
	},
	{
		layout: 'two-column',
		heading: 'Liste + formül',
		content_markdown: '- Enerji korunumu\n- Momentum korunumu\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$'
	},
	{
		layout: 'two-column',
		heading: 'Liste + kod',
		content_markdown: '- Dizi sırala\n- Sonucu yaz\n\n```ts\nconst a = [3, 1, 2].sort((x, y) => x - y);\nconsole.log(a);\n```'
	},
	{
		layout: 'two-column',
		heading: 'Görsel',
		content_markdown: '- Şekil açıklaması\n- İkinci nokta\n\n![diyagram](vc:gorsel/ornek.png)'
	}
];

const REP = (s: string, n: number) => s.repeat(n);
const QUOTE_SENT = 'Uzun bir alıntı cümlesi burada devam ediyor. ';
export const STRESS: DeckSlide[] = [
	{ layout: 'quote', heading: 'Çok uzun alıntı', content_markdown: '> ' + REP(QUOTE_SENT, 30) + '\n> — Yazar' },
	{ layout: 'quote', heading: 'Dev alıntı', content_markdown: '> ' + REP(QUOTE_SENT, 60) },
	{
		layout: 'two-column',
		heading: 'On uzun madde',
		content_markdown: Array.from({ length: 10 }, (_, i) => `- Madde ${i + 1}: ` + REP('ayrıntılı açıklama metni ', 5)).join('\n')
	},
	{
		layout: 'two-column',
		heading: 'Büyük kod',
		content_markdown:
			'- a\n- b\n\n```ts\n' +
			Array.from({ length: 14 }, (_, i) => `const veryLongVariableName${i} = computeSomethingExpensive(argumentNumberOne, argumentNumberTwo, ${i});`).join('\n') +
			'\n```'
	},
	{
		layout: 'two-column',
		heading: 'Geniş formül',
		content_markdown: '- a\n- b\n\n$$' + Array.from({ length: 14 }, (_, i) => `a_{${i}}x^{${i}}`).join(' + ') + '$$'
	}
];

function render(slides: DeckSlide[]) {
	const deck = buildMarpDeck(slides);
	const out = createSlidesMarp().render(deck);
	// Marp-core appends its own browser <script>; strip it so escaping asserts only see slide markup.
	return { deck, html: out.html.replace(/<script>[\s\S]*?<\/script>/g, ''), css: out.css };
}

test('#74 quote/two-column fixtures render through real Marp without dropping content', () => {
	const { html } = render(FIXTURES);
	assert.equal(html.match(/<section/g)?.length, FIXTURES.length);
	assert.equal(html.match(/<section [^>]* class="quote[ "]/g)?.length, 4);
	assert.equal(html.match(/<section [^>]* class="two-column[ "]/g)?.length, 5);
	// long quote: nothing truncated (first and last words + attribution)
	assert.match(html, /Bir fonksiyonun bir noktada/);
	assert.match(html, /türevlenebilir olmak zorunda değildir/);
	assert.match(html, /Bölüm 3\.2/);
	// Turkish characters preserved
	assert.match(html, /ığdır, İstanbul, ÖĞÜŞÇ/);
	// math rendered inside the quote and in a column slide
	assert.ok((html.match(/class="katex"/g) ?? []).length >= 2);
	assert.doesNotMatch(html, /\$E=mc\^2\$/);
	// unbalanced: both items present
	assert.match(html, /<li>Kısa<\/li>/);
	// code block + image survive
	assert.match(html, /<pre[^>]*>[\s\S]*console[\s\S]*<\/pre>/);
	assert.match(html, /<img[^>]+vc:gorsel\/ornek\.png/);
	// Blockquote is a real blockquote
	assert.equal(html.match(/<blockquote>/g)?.length, 4);
});

test('#74 raw HTML in quote / column content is escaped, not injected', () => {
	const { html } = render([
		{ layout: 'quote', heading: 'X', content_markdown: '> <script>alert(1)</script> <b onclick="x()">kalın</b>' },
		{ layout: 'two-column', heading: 'Y', content_markdown: '- <img src=x onerror=alert(1)>\n- <iframe src="//e"></iframe>' }
	]);
	assert.doesNotMatch(html, /<script/i);
	assert.doesNotMatch(html, /<iframe/i);
	assert.doesNotMatch(html, /<img src=x/i);
	assert.doesNotMatch(html, /onclick/i);
});

test('#74 a heading containing markdown/HTML characters does not break the slide', () => {
	const { html } = render([
		{ layout: 'quote', heading: 'A < B & "C"', content_markdown: '> x' },
		{ layout: 'two-column', heading: 'İkinci', content_markdown: '- a' }
	]);
	assert.equal(html.match(/<section/g)?.length, 2);
	assert.match(html, /A &lt; B &amp; &quot;C&quot;|A &lt; B &amp; "C"/);
});

test('#74 two-column theme: mixed content (list + pre/formula/img) is wrapped so it cannot overflow the slide', () => {
	const { css } = render(FIXTURES);
	// a column rule must exist for the layout
	assert.match(css, /section\.two-column/);
	// pre/img/katex-display must not be forced into the 2-col flow in a way that overflows:
	// they must span all columns or be constrained in width.
	assert.match(css, /section\.two-column[^{]*(pre|img|\.katex-display)[^{]*\{[^}]*(column-span|max-width|break-inside)/);
	// quote: long text is bounded by shrinking font size for long quotes
	assert.match(css, /section\.quote/);
});

test('#74 schema accepts quote/two-column slides in model-shaped JSON, with variations', () => {
	const mk = (s: Record<string, unknown>) => ({
		slides: [
			{ layout: 'title', heading: 'T', content_markdown: 'x', source_id: 'S1' },
			{ layout: 'bullets', heading: 'B', content_markdown: '- a', source_id: 'S1' },
			{ source_id: 'S1', ...s }
		]
	});
	// quote with no attribution, no notes
	assert.ok(Slides.safeParse(mk({ layout: 'quote', heading: 'Q', content_markdown: '> a' })).success);
	// two-column with notes
	assert.ok(
		Slides.safeParse(mk({ layout: 'two-column', heading: 'C', content_markdown: '- a\n- b', notes: 'n' })).success
	);
	// unknown extra keys (a model emitting left/right) are tolerated (stripped), but then content is required
	const extra = Slides.safeParse(
		mk({ layout: 'two-column', heading: 'C', content_markdown: '- a', left: ['x'], right: ['y'] })
	);
	assert.ok(extra.success);
	// left/right/columns WITHOUT content_markdown is rejected (no normalization exists)
	assert.equal(
		Slides.safeParse(mk({ layout: 'two-column', heading: 'C', left: ['x'], right: ['y'] })).success,
		false
	);
	// layout aliases like "two_column" / "columns" are rejected
	assert.equal(Slides.safeParse(mk({ layout: 'two_column', heading: 'C', content_markdown: '- a' })).success, false);
});

if (process.env.SLIDES74_OUT) {
	test('#74 write preview html', () => {
		const { html, css } = render(FIXTURES);
		writeFileSync(
			process.env.SLIDES74_OUT!,
			`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#222}${css}</style>${html}`
		);
	});
}

if (process.env.SLIDES74_STRESS_OUT) {
	test('#74 write stress html', () => {
		const { html, css } = render(STRESS);
		writeFileSync(process.env.SLIDES74_STRESS_OUT!, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#222}${css}</style>${html}`);
	});
}

test('#74 long quote / dense two-column bodies get a density class; short ones keep the bare layout class', () => {
	const deck = buildMarpDeck(FIXTURES.concat(STRESS));
	assert.match(deck, /_class: quote dense -->\n\n# Uzun alıntı/);
	assert.match(deck, /_class: quote -->\n\n# Kısa alıntı/);
	assert.match(deck, /_class: quote xdense -->\n\n# Çok uzun alıntı/);
	assert.match(deck, /_class: two-column -->\n\n# Dengeli/);
	assert.match(deck, /_class: two-column xdense -->\n\n# On uzun madde/);
	const { html, css } = render(STRESS);
	assert.match(html, /class="quote xdense"/);
	assert.match(css, /section\.quote\.xdense blockquote/);
	assert.match(css, /section\.two-column\.xdense/);
	// all 10 long items survive
	assert.equal(html.match(/Madde \d+:/g)?.length, 10);
});
