import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	chunkMarkdown,
	normalizeLevel,
	HARD_MAX_CHARS,
	findAtomicSpans,
	findDegenerateRun,
	replaceDegenerateMath,
	DEGENERATE_RUN,
	stripImageMarkup
} from './chunk';

// Regression coverage for the fix described in indexer/chunk.ts's
// isNavigationOnly doc comment: a `## Sources`/`## Related` section that is
// nothing but a list of links must never become a retrievable chunk. Against
// the real vault this affected 287 of 2442 chunks (11.8%; 15.5% of
// wiki/math) — short, link-only sections that outranked genuine content on
// any query mentioning "sources" or "access", which is exactly what broke
// chat over the math notes.

function fileWith(body: string): string {
	return `---\ntitle: "Test Note"\n---\n\n${body}\n`;
}

test('a ## Sources section made only of markdown links is dropped', () => {
	const { chunks } = chunkMarkdown(
		fileWith(
			'## Overview\n\nReal explanatory content that a reader can actually learn from.\n\n' +
				'## Sources\n- [stewart-calculus](sources/stewart-calculus.md)\n- [axler](sources/axler.md)'
		)
	);
	const headings = chunks.map((c) => c.headingPath);
	assert.ok(headings.some((h) => h.endsWith('Overview')), 'real content survives');
	assert.ok(!headings.some((h) => h.endsWith('Sources')), 'link-only Sources section is dropped');
});

test('a section made only of wikilinks is dropped the same way', () => {
	const { chunks } = chunkMarkdown(
		fileWith('## Related\n- [[linear-algebra]]\n- [[matrix-analysis]]\n* [[real-analysis]]')
	);
	assert.equal(chunks.length, 0);
});

test('a heading with no body at all produces no chunk', () => {
	const { chunks } = chunkMarkdown(fileWith('## Empty Heading\n\n## Next\n\nActual content here.'));
	assert.equal(chunks.length, 1);
	assert.ok(chunks[0].headingPath.endsWith('Next'));
});

test('a section that mixes links with real prose is kept', () => {
	const { chunks } = chunkMarkdown(
		fileWith(
			'## Foundations\n\nBuilds on [[linear-algebra]] for the spectral theorem, ' +
				'proved here without determinants via the factored characteristic polynomial.'
		)
	);
	assert.equal(chunks.length, 1);
	assert.match(chunks[0].displayText, /spectral theorem/);
});

test('a page whose only content is a Sources list yields zero chunks, not a crash', () => {
	const { chunks } = chunkMarkdown(fileWith('## Sources\n- [only-source](sources/only-source.md)'));
	assert.equal(chunks.length, 0);
});

// HARD_MAX_CHARS was declared but never actually enforced: paragraph
// splitting needs blank lines and a PDF→markdown conversion routinely has
// none, so one imported source produced a single 1.449.838-char chunk. It
// reached the model as ~362k tokens and exceeded every cloud provider's
// context window (OpenRouter: "you requested about 385182 tokens"; Groq:
// "please reduce the length of the messages"). These tests are what make the
// constant a guarantee rather than an intention.

test('a huge paragraph with no blank lines is split under HARD_MAX_CHARS', () => {
	const oneLongParagraph = 'kelime '.repeat(20000); // ~140k chars, zero blank lines
	const { chunks } = chunkMarkdown(fileWith(`## Büyük\n\n${oneLongParagraph}`));
	assert.ok(chunks.length > 1, 'an unsplittable-looking paragraph must still split');
	for (const c of chunks) {
		assert.ok(
			c.displayText.length <= HARD_MAX_CHARS,
			`chunk of ${c.displayText.length} chars exceeds HARD_MAX_CHARS (${HARD_MAX_CHARS})`
		);
	}
});

test('a huge fenced code block is split under HARD_MAX_CHARS', () => {
	// No spaces or newlines inside: forces hardSplit's mid-token cut, the
	// branch a minified blob or base64 payload would hit.
	const giant = '```\n' + 'x'.repeat(100000) + '\n```';
	const { chunks } = chunkMarkdown(fileWith(`## Kod\n\n${giant}`));
	assert.ok(chunks.length > 1, 'a code block bigger than the budget must split');
	for (const c of chunks) {
		assert.ok(
			c.displayText.length <= HARD_MAX_CHARS,
			`chunk of ${c.displayText.length} chars exceeds HARD_MAX_CHARS (${HARD_MAX_CHARS})`
		);
	}
});

// The old splitter ran plain hardSplit() over an
// oversized code block's raw text as if it were prose, so only the first
// piece kept the opening ``` and only the last kept the closing ``` — a
// 150-line C block over budget rendered as one real fenced block followed by
// unfenced plain-text fragments. "Code blocks are atomic" was only true
// below 2048 characters.

test('an oversized fenced code block splits into individually-fenced pieces with every line intact', () => {
	// Deeply indented, matching a real Python function body — hardSplit()'s
	// `.replace(/^\s+/, '')` on the continuation would strip exactly this
	// leading whitespace at every split point, silently de-indenting it.
	const lines = Array.from({ length: 300 }, (_, i) => `        value_${i} = compute_something(x, y, z_${i})`);
	const original = lines.join('\n');
	const giant = '```python\n' + original + '\n```';
	const { chunks } = chunkMarkdown(fileWith(`## Kod\n\n${giant}`));
	assert.ok(chunks.length > 1, 'a code block bigger than the budget must split');

	const fenceRe = /```python\n([\s\S]*?)\n```/;
	let reassembled = '';
	let fencedPieceCount = 0;
	for (const c of chunks) {
		assert.ok(c.displayText.length <= HARD_MAX_CHARS);
		const m = fenceRe.exec(c.displayText);
		if (!m) continue; // e.g. a leading heading-only chunk with no code in it
		fencedPieceCount++;
		reassembled += (reassembled ? '\n' : '') + m[1];
	}
	assert.ok(fencedPieceCount > 1, 'expected more than one fenced piece, not one block plus unfenced fragments');
	assert.equal(
		reassembled,
		original,
		'every line must survive unaltered, in order and correctly indented, once fences are stripped back off'
	);
});

// `## ` is a common comment marker in Python/shell. A
// `## not a heading` line inside a fenced code block used to be scanned as a
// real section break, splitting the code block in two mid-block.

test('a "## " comment line inside a fenced code block is not treated as a heading', () => {
	const { chunks } = chunkMarkdown(
		fileWith(
			'## Kod testi\n\n```python\n' +
				'## bu bir yorum satırı, başlık değil\n' +
				'print("hello")\n' +
				'```\n'
		)
	);
	assert.equal(chunks.length, 1, 'the code block must not be split into a second, phantom section');
	assert.ok(chunks[0].headingPath.endsWith('Kod testi'));
	assert.ok(!chunks[0].headingPath.includes('yorum satırı'), 'the comment text must never leak into headingPath');
	assert.ok(chunks[0].displayText.includes('```python'), 'the fence itself must survive intact');
});

test('a real heading right after a fenced block that contains a "## " comment is still found', () => {
	const { chunks } = chunkMarkdown(
		fileWith(
			'## Bölüm A\n\n```python\n## not a heading\n```\n\n## Bölüm B\n\nGerçek içerik burada.\n'
		)
	);
	const headings = chunks.map((c) => c.headingPath);
	assert.ok(headings.some((h) => h.endsWith('Bölüm A')));
	assert.ok(headings.some((h) => h.endsWith('Bölüm B')));
});

test('ordinary short content is still one chunk, not fragmented', () => {
	const { chunks } = chunkMarkdown(fileWith('## Kısa\n\nBir iki cümlelik tamamen normal içerik.'));
	assert.equal(chunks.length, 1);
});

test('normalizeLevel folds known synonyms to the CLAUDE.md-canonical spelling', () => {
	assert.equal(normalizeLevel('undergraduate'), 'undergrad');
	assert.equal(normalizeLevel('Undergraduate'), 'undergrad');
	assert.equal(normalizeLevel('graduate'), 'grad');
	assert.equal(normalizeLevel('doctorate'), 'phd');
	assert.equal(normalizeLevel('doctoral'), 'phd');
});

test('normalizeLevel leaves already-canonical and unknown values untouched', () => {
	assert.equal(normalizeLevel('undergrad'), 'undergrad');
	assert.equal(normalizeLevel('grad'), 'grad');
	assert.equal(normalizeLevel('phd'), 'phd');
	assert.equal(normalizeLevel(''), '');
	assert.equal(normalizeLevel('meta'), 'meta');
});

// Hand-written YAML frontmatter has no runtime schema
// check. `level: 3` parses to a JS number, `level: [a, b]` to an array —
// normalizeLevel used to call `.trim()` unconditionally and threw
// `TypeError: level.trim is not a function`, which aborted the whole indexing
// run mid-walk: files alphabetically after the bad one were silently never
// indexed, and --dry-run never caught it ahead of time because the crashing
// call only happened inside the real-write branch.

test('normalizeLevel never throws on a non-string frontmatter value and falls back to empty', () => {
	assert.equal(normalizeLevel(3), '');
	assert.equal(normalizeLevel(['undergrad']), '');
	assert.equal(normalizeLevel({ x: 1 }), '');
	assert.equal(normalizeLevel(true), '');
	assert.equal(normalizeLevel(null), '');
	assert.equal(normalizeLevel(undefined), '');
});

// Line-anchored delimiters: a stray `$$` or ``` in the middle of a line must
// never open or close a block (it used to shift pairing for the rest of the file).

test('a stray inline $$ in a table cell does not shift later display-math blocks', () => {
	const body =
		'## Tablo\n\n<table><tr><td>IXTT02N450$$</td></tr></table>\n\nSonra düz bir paragraf burada.\n\n' +
		'$$\nx = 1\n$$\n\nBir paragraf daha.\n\n$$ y = 2 $$\n';
	const spans = findAtomicSpans(body);
	assert.deepEqual(
		spans.map((s) => [s.type, body.slice(s.start, s.end)]),
		[
			['math', '$$\nx = 1\n$$'],
			['math', '$$ y = 2 $$']
		]
	);
	const { chunks } = chunkMarkdown(fileWith(body));
	const text = chunks.map((c) => c.displayText).join('\n');
	assert.ok(text.includes('Sonra düz bir paragraf burada.'));
	assert.ok(text.includes('Bir paragraf daha.'));
});

test('a stray ``` inside a code line does not open a fence', () => {
	const body = '## A\n\nkullan: echo "```" yaz\n\nDüz paragraf.\n\n```c\nint x;\n```\n\n## B\n\nSon.';
	const spans = findAtomicSpans(body);
	assert.equal(spans.length, 1);
	assert.equal(body.slice(spans[0].start, spans[0].end), '```c\nint x;\n```');
	const { chunks } = chunkMarkdown(fileWith(body));
	assert.deepEqual(
		chunks.map((c) => c.headingPath),
		['Test Note > A', 'Test Note > B']
	);
});

test('a ## heading after a stray delimiter is still a section', () => {
	const body = '## Bir\n\nhücre IXTT02N450$$ bitti\n\n## İki\n\nmetin\n\n## Üç\n\n$$\na\n$$\n';
	const { chunks } = chunkMarkdown(fileWith(body));
	assert.deepEqual(
		chunks.map((c) => c.headingPath),
		['Test Note > Bir', 'Test Note > İki', 'Test Note > Üç']
	);
});

test('CRLF input: blocks are found and headings after them survive', () => {
	const body = '## Bir\r\n\r\n$$\r\nx = 1\r\n$$\r\n\r\n```py\r\n## yorum\r\nprint(1)\r\n```\r\n\r\n## İki\r\n\r\nmetin\r\n';
	const spans = findAtomicSpans(body);
	assert.deepEqual(spans.map((s) => s.type), ['math', 'code']);
	assert.ok(!body.slice(spans[0].start, spans[0].end).endsWith('\r'));
	const { chunks } = chunkMarkdown(`---\r\ntitle: "T"\r\n---\r\n\r\n${body}`);
	assert.deepEqual(chunks.map((c) => c.headingPath), ['T > Bir', 'T > İki']);
});

test('a 4-backtick fence may contain ``` lines; a tilde fence is only closed by tildes', () => {
	const body = '````md\n```js\nlet a;\n```\n````\n\n~~~\n```\nstill code\n~~~\n';
	const spans = findAtomicSpans(body);
	assert.equal(spans.length, 2);
	assert.equal(body.slice(spans[0].start, spans[0].end), '````md\n```js\nlet a;\n```\n````');
	assert.equal(body.slice(spans[1].start, spans[1].end), '~~~\n```\nstill code\n~~~');
});

test('single-line display math on its own line is one block; inline $$ mid-line is not', () => {
	assert.equal(findAtomicSpans('$$ x = 1 $$').length, 1);
	assert.equal(findAtomicSpans('a $$ x $$ b').length, 0);
	assert.equal(findAtomicSpans('a\n$$ x\ny $$ trailing\n').length, 0);
});

// Docling formula loops.

const LOOP = '\\begin{array}{l} \\text {for (i = 1;i <   100;i = i + 1) \\{} \\\\ ' + '\\quad '.repeat(3900);

test('findDegenerateRun flags a periodic run and ignores legitimate repetition', () => {
	assert.ok(findDegenerateRun(LOOP) > 0);
	assert.equal(findDegenerateRun('a + b + '.repeat(DEGENERATE_RUN / 4) + 'c'), -1);
	assert.equal(findDegenerateRun('\\begin{pmatrix} ' + '1 & 0 \\\\ '.repeat(30) + '\\end{pmatrix}'), -1);
	const two = 'x = ' + 'a b '.repeat(DEGENERATE_RUN + 5);
	assert.equal(findDegenerateRun(two), 4);
});

test('replaceDegenerateMath keeps the head, drops the loop, and yields at most two chunks', () => {
	const doc = fileWith(`## Kod\n\nÖnce.\n\n$$${LOOP}$$\n\nSonra.`);
	const fixed = replaceDegenerateMath(doc);
	assert.ok(fixed.length < 1500);
	assert.ok(fixed.includes('> ⚠️ Bu formül PDF\'ten tam çıkarılamadı'));
	assert.ok(fixed.includes('```latex\n\\begin{array}{l} \\text {for (i = 1;i <   100;i = i + 1) \\{}\n```'));
	assert.ok(fixed.includes('Önce.') && fixed.includes('Sonra.'));
	const { chunks } = chunkMarkdown(doc);
	assert.ok(chunks.length <= 2, `got ${chunks.length} chunks`);
	assert.ok(chunks.every((c) => c.displayText.length <= HARD_MAX_CHARS));
});

test('replaceDegenerateMath omits the latex fence when the head is empty and leaves good math alone', () => {
	const fixed = replaceDegenerateMath('a\n\n$$' + '\\quad '.repeat(500) + '$$\n\nb\n\n$$\nx^2\n$$\n');
	assert.ok(fixed.includes('kaynak sayfaya bakın.'));
	assert.ok(!fixed.includes('```latex'));
	assert.ok(fixed.includes('$$\nx^2\n$$'));
	const same = 'a\n\n$$\nx^2 + y^2\n$$\n';
	assert.equal(replaceDegenerateMath(same), same);
});

// Converted images (ingest/images.py): the link target and the vc:gorsel marker
// must stay out of the embedded text; alt text and the Görsel line stay in.
test('stripImageMarkup drops link target and marker, keeps alt and description', () => {
	const md = '![Şekil 1: Ağ](../_meta/attachments/a2694c9b3808ec89.png)\n<!-- vc:gorsel a2694c9b3808ec89 -->\n*Görsel:* İki sunucu arası bağlantı';
	assert.equal(stripImageMarkup(md), 'Şekil 1: Ağ\n*Görsel:* İki sunucu arası bağlantı');
	assert.equal(stripImageMarkup('![](x/a.png "t")\nmetin'), '\nmetin');
});

test('stripImageMarkup also drops the unreadable-formula marker (ingest/formula_fallback.py)', () => {
	const md = '![Okunamayan formül — s. 12](../_meta/attachments/a2694c9b3808ec89.png)\n<!-- vc:formul-gorsel a2694c9b3808ec89 s.12 -->\n\n```latex\nx^2\n```';
	assert.equal(stripImageMarkup(md), 'Okunamayan formül — s. 12\n\n```latex\nx^2\n```');
});

test('chunkMarkdown: displayText keeps the image, embedText does not; image-only section yields no chunk', () => {
	const body = [
		'## Rota',
		'Haritada rota gösterilir.',
		'![](../_meta/attachments/a2694c9b3808ec89.png)',
		'<!-- vc:gorsel a2694c9b3808ec89 -->',
		'',
		'## Boş slayt',
		'![](../_meta/attachments/0123456789abcdef.png)',
		'<!-- vc:gorsel 0123456789abcdef -->'
	].join('\n');
	const { chunks } = chunkMarkdown(fileWith(body));
	assert.equal(chunks.length, 1);
	assert.ok(chunks[0].displayText.includes('a2694c9b3808ec89.png'));
	assert.ok(!chunks[0].embedText.includes('a2694c9b3808ec89'));
	assert.ok(chunks[0].embedText.includes('Haritada rota gösterilir.'));
});

test('stripImageMarkup drops the hidden formul-latex comment', () => {
	const md = '![Okunamayan formül — s. 12](a.png)\n<!-- vc:formul-gorsel a2694c9b3808ec89 s.12 -->\n\n> ⚠ Formül okunamadı — s. 12\n\n<!-- vc:formul-latex eFxe2 -->\n';
	assert.equal(stripImageMarkup(md), 'Okunamayan formül — s. 12\n\n> ⚠ Formül okunamadı — s. 12\n\n');
});

test('stripImageMarkup also drops a formul-gorsel marker that carries a k= box', () => {
	const md = '![x](a.png)\n<!-- vc:formul-gorsel a2694c9b3808ec89 s.12 k=72,100.5,300,-4 -->\ntext\n';
	assert.equal(stripImageMarkup(md), 'x\ntext\n');
});
