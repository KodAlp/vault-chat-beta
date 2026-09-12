import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown, normalizeLevel } from './chunk';

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
