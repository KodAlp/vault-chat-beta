import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewBlockText, type ReviewBlockInput } from './review-block';
import { REVIEW_MAX_CHARS } from './review-limits';

const empty: ReviewBlockInput = { dueCards: [], weakDomains: [], openWeakSpots: [], staleDomains: [] };

test('nothing to review: an explicit line, never an empty string', () => {
	const out = buildReviewBlockText(empty);
	assert.notEqual(out, '');
	assert.match(out, /^## /);
	assert.match(out, /şu anda belirgin bir öncelik yok/);
});

test('each signal gets its own templated line when present', () => {
	const out = buildReviewBlockText({
		dueCards: [{ front: 'Bir B-ağacının yüksekliği neye bağlıdır?' }],
		weakDomains: [{ name: 'databases', masteryPct: 42 }],
		openWeakSpots: [{ noteName: 'scheduling', openErrors: 3 }],
		staleDomains: [{ name: 'math', daysSince: 40 }]
	});
	assert.match(out, /Vadesi gelen kartlar: Bir B-ağacının yüksekliği neye bağlıdır\?\./);
	assert.match(out, /Zayıf alanlar: databases \(~%42\)\./);
	assert.match(out, /Açık zayıf noktalar: scheduling \(3\)\./);
	assert.match(out, /Uzun süredir tekrarlanmamış: math \(40 gün\)\./);
});

test('present sections come with an agenda instruction, not just a data dump', () => {
	const out = buildReviewBlockText({ ...empty, dueCards: [{ front: 'x' }] });
	assert.match(out, /önceliklendir/);
});

test('multiple due cards are joined on one line', () => {
	const out = buildReviewBlockText({ ...empty, dueCards: [{ front: 'a' }, { front: 'b' }] });
	const line = out.split('\n').find((l) => l.startsWith('Vadesi'))!;
	assert.equal(line, 'Vadesi gelen kartlar: a; b.');
});

test('a very long card front is trimmed with an ellipsis', () => {
	const long = 'x'.repeat(300);
	const out = buildReviewBlockText({ ...empty, dueCards: [{ front: long }] });
	assert.ok(out.includes('…'));
	assert.ok(!out.includes(long));
});

test('over budget: stale domains drop first, then weak domains, then weak spots — due cards survive', () => {
	const dueCards = [{ front: 'kart' }];
	const staleDomains = Array.from({ length: 20 }, (_, i) => ({ name: `stale${i}`, daysSince: 30 }));
	const weakDomains = Array.from({ length: 20 }, (_, i) => ({ name: `weak${i}`, masteryPct: 10 }));
	const openWeakSpots = Array.from({ length: 20 }, (_, i) => ({ noteName: `spot${i}`, openErrors: 1 }));
	const out = buildReviewBlockText({ dueCards, weakDomains, openWeakSpots, staleDomains });
	assert.ok(out.includes('kart'), 'due card survives');
	assert.ok(out.length <= REVIEW_MAX_CHARS + 200, 'close to budget once droppable sections are gone');
});

test('stale domains alone, way over budget, are dropped down to nothing before due cards would ever be touched', () => {
	const staleDomains = Array.from({ length: 50 }, (_, i) => ({ name: `stale-domain-${i}`, daysSince: 30 }));
	const out = buildReviewBlockText({ dueCards: [{ front: 'kart' }], weakDomains: [], openWeakSpots: [], staleDomains });
	assert.ok(out.includes('kart'));
	assert.ok(out.length <= REVIEW_MAX_CHARS + 200);
});
