import test from 'node:test';
import assert from 'node:assert/strict';
import { topicSpread } from './topic-spread';

const c = (...domains: string[]) => ({ domains });

test('three distinct topics are returned in first-appearance order', () => {
	assert.deepEqual(topicSpread([c('Algoritma'), c('Bellek'), c('Veri Yapıları')]), ['Algoritma', 'Bellek', 'Veri Yapıları']);
});

test('two distinct topics are not a spread', () => {
	assert.deepEqual(topicSpread([c('A'), c('B'), c('A')]), []);
});

test('"genel" is ignored, case-insensitively', () => {
	assert.deepEqual(topicSpread([c('genel'), c('Genel'), c('A'), c('B')]), []);
	assert.deepEqual(topicSpread([c('genel', 'A'), c('GENEL'), c('B'), c('C')]), ['A', 'B', 'C']);
});

test('duplicates differing only in case collapse and keep the first spelling', () => {
	assert.deepEqual(topicSpread([c('Fizik'), c('fizik'), c('B'), c('C')]), ['Fizik', 'B', 'C']);
});

test('result is capped at 4 by default and at opts.max when given', () => {
	const chunks = ['A', 'B', 'C', 'D', 'E', 'F'].map((d) => c(d));
	assert.deepEqual(topicSpread(chunks), ['A', 'B', 'C', 'D']);
	assert.deepEqual(topicSpread(chunks, { max: 3 }), ['A', 'B', 'C']);
});

test('chunks without a usable domain are skipped; opts.min is honoured', () => {
	assert.deepEqual(topicSpread([c(), c(''), c('  '), c('A'), c('B'), c('C')]), ['A', 'B', 'C']);
	assert.deepEqual(topicSpread([c('A'), c('B')], { min: 2 }), ['A', 'B']);
});
