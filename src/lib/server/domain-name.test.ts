import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDomain, MAX_DOMAIN_LENGTH } from './domain-name';

const EMOJI = String.fromCodePoint(0x1f600);
const BOOKS = String.fromCodePoint(0x1f4da);

test('plain readable names are kept as they are', () => {
	assert.equal(sanitizeDomain('math'), 'math');
	assert.equal(sanitizeDomain('Kitaplar\u0131m'), 'Kitaplar\u0131m');
	assert.equal(sanitizeDomain('Do\u011frusal Cebir 2'), 'Do\u011frusal Cebir 2');
});

test('NFD input is normalized to NFC', () => {
	const nfd = 'O' + String.fromCharCode(0x308) + 'dev';
	const out = sanitizeDomain(nfd);
	assert.equal(out, out.normalize('NFC'));
	assert.equal(out, '\u00d6dev');
	assert.notEqual(out, nfd);
});

test('empty, whitespace and dot-only fall back to genel', () => {
	for (const s of ['', '   ', '..', '.', '...  ', '///', '\x00']) {
		assert.equal(sanitizeDomain(s), 'genel');
	}
});

test('separators and drive letters cannot add or remove path levels', () => {
	assert.equal(sanitizeDomain('a/b'), 'ab');
	assert.equal(sanitizeDomain('a\\b'), 'ab');
	assert.equal(sanitizeDomain('C:'), 'C');
	assert.equal(sanitizeDomain('C:\\Windows'), 'CWindows');
	assert.equal(sanitizeDomain('../../etc'), 'etc');
	for (const bad of ['a/../b', '..\\..\\x', '/abs', 'x/']) {
		assert.doesNotMatch(sanitizeDomain(bad), /[/\\]/);
		assert.notEqual(sanitizeDomain(bad), '..');
	}
});

test('Windows-invalid and control characters are stripped', () => {
	assert.equal(sanitizeDomain('a<b>c:d"e|f?g*h'), 'abcdefgh');
	assert.equal(sanitizeDomain('a\x00b\x07c\x1fd'), 'abcd');
	assert.equal(sanitizeDomain('a\u202eb\u200bc'), 'abc');
});

test('whitespace is collapsed and trailing dots/spaces dropped', () => {
	assert.equal(sanitizeDomain('  x.  '), 'x');
	assert.equal(sanitizeDomain('a   b\t\nc'), 'a b c');
	assert.equal(sanitizeDomain('name. . '), 'name');
	assert.equal(sanitizeDomain('.hidden'), 'hidden');
	assert.equal(sanitizeDomain('a \x00 b'), 'a b');
});

test('indexer-excluded and internal names get a suffix, any case', () => {
	assert.equal(sanitizeDomain('attachments'), 'attachments-klasoru');
	assert.equal(sanitizeDomain('Templates'), 'Templates-klasoru');
	assert.equal(sanitizeDomain('RAW'), 'RAW-klasoru');
	assert.equal(sanitizeDomain('node_modules'), 'node_modules-klasoru');
	assert.equal(sanitizeDomain('_meta'), '_meta-klasoru');
	assert.equal(sanitizeDomain('_META'), '_META-klasoru');
});

test('Windows device names get a suffix, also with an extension', () => {
	assert.equal(sanitizeDomain('con'), 'con-klasoru');
	assert.equal(sanitizeDomain('NUL'), 'NUL-klasoru');
	assert.equal(sanitizeDomain('Com1'), 'Com1-klasoru');
	assert.equal(sanitizeDomain('lpt9'), 'lpt9-klasoru');
	assert.equal(sanitizeDomain('con.txt'), 'con.txt-klasoru');
	assert.equal(sanitizeDomain('console'), 'console');
	assert.equal(sanitizeDomain('com10'), 'com10');
});

test('very long names are capped in code points and bytes', () => {
	assert.equal(sanitizeDomain('a'.repeat(300)).length, MAX_DOMAIN_LENGTH);
	const emoji = sanitizeDomain(EMOJI.repeat(300));
	assert.ok(Array.from(emoji).length <= MAX_DOMAIN_LENGTH);
	assert.ok(Buffer.byteLength(emoji, 'utf8') <= 180);
	assert.ok(emoji.length > 0);
	// A cut that ends on a dot or space is cleaned up.
	assert.equal(sanitizeDomain('a'.repeat(63) + '. b'), 'a'.repeat(63));
});

test('emoji and non-latin names survive', () => {
	assert.equal(sanitizeDomain('Notlar ' + BOOKS), 'Notlar ' + BOOKS);
	assert.equal(sanitizeDomain('\u6570\u5b66'), '\u6570\u5b66');
});

test('the result is never empty, dot-led, separator-bearing or dot/space-terminated', () => {
	const inputs = ['', '.', '..', 'con', 'a/b', 'raw', ' x ', 'x.', '\x00', 'C:', 'templates/..'];
	for (const i of inputs) {
		const out = sanitizeDomain(i);
		assert.ok(out.length > 0);
		assert.ok(!out.startsWith('.'));
		assert.doesNotMatch(out, /[/\\:*?"<>|]/);
		assert.ok(!/[. ]$/.test(out));
	}
});
