import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequirementsImportNames, buildModuleCheckScript } from './pythonModules';

test('parses dist names and folds dashes to underscores for import names', () => {
	const specs = parseRequirementsImportNames(
		[
			'markitdown[all]==0.1.6',
			'yt-dlp==2026.7.4',
			'trafilatura==2.2.0',
			'py-asciimath==0.3.0',
			'pypdf==6.14.2'
		].join('\n')
	);
	assert.deepEqual(specs, [
		{ distName: 'markitdown', importName: 'markitdown' },
		{ distName: 'yt-dlp', importName: 'yt_dlp' },
		{ distName: 'trafilatura', importName: 'trafilatura' },
		{ distName: 'py-asciimath', importName: 'py_asciimath' },
		{ distName: 'pypdf', importName: 'pypdf' }
	]);
});

test('skips comment lines and blank lines', () => {
	const specs = parseRequirementsImportNames(
		['# a full-line comment', '', '   ', 'pypdf==6.14.2  # trailing comment too'].join('\n')
	);
	assert.deepEqual(specs, [{ distName: 'pypdf', importName: 'pypdf' }]);
});

test('strips extras markers before the version pin', () => {
	const specs = parseRequirementsImportNames('markitdown[all]==0.1.6');
	assert.deepEqual(specs, [{ distName: 'markitdown', importName: 'markitdown' }]);
});

test('handles an unpinned/bare requirement line', () => {
	const specs = parseRequirementsImportNames('some-package');
	assert.deepEqual(specs, [{ distName: 'some-package', importName: 'some_package' }]);
});

test('real ingest/requirements.txt shape parses to exactly the five expected modules', () => {
	// Mirrors ingest/requirements.txt's actual required (non-optional) block —
	// this is the exact list PythonStatusBanner and the setup page's system
	// check both depend on staying accurate.
	const text = `
# Faz 5 (scoped): MarkItDown only.
markitdown[all]==0.1.6

# YouTube transcript ingest
yt-dlp==2026.7.4

trafilatura==2.2.0

py-asciimath==0.3.0

pypdf==6.14.2

# Marker and Docling stay OPTIONAL, listed in a separate file.
`;
	const importNames = parseRequirementsImportNames(text).map((s) => s.importName);
	assert.deepEqual(importNames, ['markitdown', 'yt_dlp', 'trafilatura', 'py_asciimath', 'pypdf']);
});

test('buildModuleCheckScript produces one try/except per module and a final JSON print', () => {
	const script = buildModuleCheckScript(['markitdown', 'yt_dlp']);
	assert.ok(script.includes('__import__("markitdown")'));
	assert.ok(script.includes('__import__("yt_dlp")'));
	assert.ok(script.includes('print(json.dumps(results))'));
	// Exactly one try/except pair per module, not one combined import statement.
	assert.equal(script.match(/try:/g)?.length, 2);
});

test('buildModuleCheckScript JSON-escapes names safely (defense in depth, even though inputs are our own fixed list)', () => {
	const script = buildModuleCheckScript(['weird"name']);
	assert.ok(script.includes(JSON.stringify('weird"name')));
});
