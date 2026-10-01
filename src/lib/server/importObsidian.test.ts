import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { expandHome, indexKey, rewriteWikilinks } from './importObsidian';

test('an NFD filename on disk resolves an NFC [[wikilink]] (and vice versa)', () => {
	const nfdName = 'Çalışma Şeması'.normalize('NFD');
	const nfcName = 'Çalışma Şeması'.normalize('NFC');
	assert.notEqual(nfdName, nfcName);
	const index = new Map([[indexKey(nfdName), 'konu/Çalışma.md']]);
	const out = rewriteWikilinks(`bkz [[${nfcName}]]`, 'a.md', index);
	assert.match(out, /^bkz \[.*\]\(konu\/.*\.md\)$/);
	const index2 = new Map([[indexKey(nfcName), 'x.md']]);
	assert.match(rewriteWikilinks(`[[${nfdName}]]`, 'a.md', index2), /\]\(x\.md\)/);
});

test('expandHome expands a leading ~ and leaves other paths alone', () => {
	const home = path.join(path.sep, 'home', 'alp');
	assert.equal(expandHome('~', home), home);
	assert.equal(expandHome('~/MyVault', home), path.join(home, 'MyVault'));
	assert.equal(expandHome('~\\MyVault', home), path.join(home, 'MyVault'));
	assert.equal(expandHome('/abs/~/x', home), '/abs/~/x');
	assert.equal(expandHome('~other/x', home), '~other/x');
	assert.equal(expandHome('rel/path', home), 'rel/path');
});
