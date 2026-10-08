import { test } from 'node:test';
import assert from 'node:assert/strict';
import matter from 'gray-matter';
import { mergeReimportFrontmatter, buildReimportedNote } from './reimport';

test('title, domain and level stay the user\'s; converter keys come from the new conversion', () => {
	const merged = mergeReimportFrontmatter(
		{ title: 'My title', domain: 'fizik', level: 'graduate', source_sha256: 'old', converted_by: 'docling-old' },
		{ title: 'Converted title', domain: 'genel', level: 'undergraduate', source_sha256: 'new', converted_by: 'docling' }
	);
	assert.equal(merged.title, 'My title');
	assert.equal(merged.domain, 'fizik');
	assert.equal(merged.level, 'graduate');
	assert.equal(merged.source_sha256, 'new');
	assert.equal(merged.converted_by, 'docling');
});

test('keys only the old note has (tags, aliases) survive; keys only the new one has are added', () => {
	const merged = mergeReimportFrontmatter({ title: 'T', tags: ['a', 'b'], aliases: ['x'] }, { title: 'N', page_count: 12 });
	assert.deepEqual(merged.tags, ['a', 'b']);
	assert.deepEqual(merged.aliases, ['x']);
	assert.equal(merged.page_count, 12);
});

test('a converter key that disappeared from the new conversion is kept from the old note', () => {
	assert.equal(mergeReimportFrontmatter({ converted_at: 'then' }, {}).converted_at, 'then');
});

test('buildReimportedNote: fresh body, merged frontmatter, CRLF kept when the old note used it', () => {
	const old = '---\r\ntitle: Mine\r\ntags:\r\n  - t1\r\nsource_sha256: aaa\r\n---\r\nOld body\r\n';
	const converted = '---\ntitle: Auto\nsource_sha256: bbb\n---\n# New body\n\nText\n';
	const out = buildReimportedNote(old, converted);
	assert.ok(out.includes('\r\n') && !/[^\r]\n/.test(out), 'line endings are all CRLF');
	const parsed = matter(out);
	assert.equal(parsed.data.title, 'Mine');
	assert.equal(parsed.data.source_sha256, 'bbb');
	assert.deepEqual(parsed.data.tags, ['t1']);
	assert.ok(parsed.content.includes('# New body'));
	assert.ok(!parsed.content.includes('Old body'));
});

test('buildReimportedNote: an explicit body (images already re-linked) replaces the converted one', () => {
	const out = buildReimportedNote('---\ntitle: A\n---\nx\n', '---\ntitle: B\n---\nraw\n', '![i](../_meta/attachments/a.png)\n');
	assert.ok(out.includes('../_meta/attachments/a.png'));
	assert.ok(!out.includes('raw'));
	assert.ok(!out.includes('\r'));
});
