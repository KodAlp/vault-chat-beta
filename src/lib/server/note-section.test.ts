import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSection, findHeadings, pageText, HeadingNotFoundError } from './note-section';

const NOTE = [
	'# Title',
	'intro',
	'## Setup',
	'setup text',
	'```bash',
	'# not a heading',
	'## also not',
	'```',
	'### Detail',
	'detail text',
	'## Usage',
	'usage text',
	'~~~',
	'# tilde code',
	'~~~',
	'# Second',
	'tail'
].join('\n');

test('findHeadings ignores # lines inside fenced code blocks', () => {
	assert.deepEqual(
		findHeadings(NOTE).map((h) => h.text),
		['Title', 'Setup', 'Detail', 'Usage', 'Second']
	);
});

test('a section runs to the next heading of the same or higher level and keeps nested ones', () => {
	const s = extractSection(NOTE, 'Setup');
	assert.equal(s.level, 2);
	assert.ok(s.text.startsWith('## Setup'));
	assert.ok(s.text.includes('# not a heading'));
	assert.ok(s.text.includes('### Detail') && s.text.includes('detail text'));
	assert.ok(!s.text.includes('## Usage'));
	// The level-1 title swallows every ## below it, up to the next level-1 heading.
	const top = extractSection(NOTE, 'Title');
	assert.ok(top.text.includes('## Usage') && top.text.includes('# tilde code') && !top.text.includes('# Second'));
});

test('last section runs to the end; matching is exact first, then case-insensitive; leading #s optional', () => {
	assert.equal(extractSection(NOTE, 'second').text, '# Second\ntail');
	assert.equal(extractSection(NOTE, '## usage').heading, 'Usage');
	const dup = '## A\none\n## a\ntwo';
	assert.equal(extractSection(dup, 'a').text, '## a\ntwo');
	assert.equal(extractSection(dup, 'A').matches, 1);
	assert.equal(extractSection(dup, 'A').text, '## A\none');
});

test('missing heading gives a clear error listing the available headings', () => {
	assert.throws(
		() => extractSection(NOTE, 'Nope'),
		(e: unknown) => e instanceof HeadingNotFoundError && e.message.includes('Nope') && e.message.includes('Setup | Detail')
	);
	assert.throws(() => extractSection('no headings here', 'x'), /\(yok\)/);
});

test('pageText pages by characters and reports the next offset', () => {
	const p1 = pageText('abcdefghij', 0, 4);
	assert.deepEqual(p1, { text: 'abcd', offset: 0, totalChars: 10, nextOffset: 4 });
	const p3 = pageText('abcdefghij', 8, 4);
	assert.deepEqual(p3, { text: 'ij', offset: 8, totalChars: 10, nextOffset: null });
	assert.equal(pageText('abc', 99, 4).text, '');
});
