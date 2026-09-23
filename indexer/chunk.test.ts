import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown, normalizeLevel, HARD_MAX_CHARS } from './chunk';

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

// Ö4 (2026-09-23 report): the old splitter ran plain hardSplit() over an
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

// Ö3 (2026-09-23 report): `## ` is a common comment marker in Python/shell. A
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

// Ö2 (2026-09-23 report): hand-written YAML frontmatter has no runtime schema
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
