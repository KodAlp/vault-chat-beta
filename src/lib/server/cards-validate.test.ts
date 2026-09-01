import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAndValidateCards, type CitedChunk } from './cards-validate';

const chunks = new Map<string, CitedChunk>([
	[
		'S1',
		{
			path: 'wiki/math/sources/vershynin-high-dimensional-probability.md',
			heading_path: 'Türev > Tanım',
			domains: ['math'],
			depth: 'grad'
		}
	],
	[
		'S2',
		{
			path: 'wiki/math/calculus.md',
			heading_path: 'Türev > Kurallar',
			domains: ['math'],
			depth: 'undergrad'
		}
	]
]);

const raw = (items: unknown) => JSON.stringify({ items });

test('a valid response resolves source_id to the server-side chunk metadata', () => {
	const r = parseAndValidateCards(
		raw([{ front: 'Türevin tanımı?', back: 'Anlık değişim oranı.', source_id: 'S1' }]),
		chunks
	);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(r.items.length, 1);
	// This is what the whole id scheme buys: the model never had to type the
	// long path, so it can never get it wrong.
	assert.equal(r.items[0].source_path, 'wiki/math/sources/vershynin-high-dimensional-probability.md');
	assert.equal(r.items[0].heading_path, 'Türev > Tanım');
	assert.equal(r.items[0].domain, 'math');
	assert.equal(r.items[0].level, 'grad');
	assert.equal(r.items[0].front, 'Türevin tanımı?');
	assert.equal(r.items[0].back, 'Anlık değişim oranı.');
});

test('an invented source_id is rejected as a hallucinated citation', () => {
	const r = parseAndValidateCards(
		raw([{ front: 'Q', back: 'A', source_id: 'S99' }]),
		chunks
	);
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.match(r.error, /source_id/);
});

test('a card with no domains on its chunk falls back to "genel"', () => {
	const noDomain = new Map<string, CitedChunk>([
		['S1', { path: 'a.md', heading_path: 'A', domains: [], depth: 'undergrad' }]
	]);
	const r = parseAndValidateCards(raw([{ front: 'Q', back: 'A', source_id: 'S1' }]), noDomain);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(r.items[0].domain, 'genel');
});

test('non-JSON and schema-invalid responses are rejected, not thrown', () => {
	assert.equal(parseAndValidateCards('not json', chunks).ok, false);
	assert.equal(parseAndValidateCards(raw([{ front: 'Q' }]), chunks).ok, false);
});

test('an empty item list is rejected', () => {
	const r = parseAndValidateCards(raw([]), chunks);
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.match(r.error, /hiç kart/);
});

test('a mix of valid and invented ids rejects the whole batch', () => {
	const r = parseAndValidateCards(
		raw([
			{ front: 'Q1', back: 'A1', source_id: 'S1' },
			{ front: 'Q2', back: 'A2', source_id: 'S-does-not-exist' }
		]),
		chunks
	);
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.match(r.error, /1 kartın/);
});
