import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeItems, questionKey } from './quiz-dedupe';

const q = (question: string) => ({ question });

test('case, extra whitespace and trailing punctuation do not make a question different', () => {
	assert.equal(questionKey('Dijkstra   algoritması NEDİR?'), questionKey('dijkstra algoritması nedir'));
	assert.equal(questionKey('  Hangi yöntem?  '), questionKey('Hangi yöntem.'));
});

test('a verbatim repeat is dropped, the first occurrence is kept, order is preserved', () => {
	const r = dedupeItems([q('Riemann-Stieltjes integralinin tanımı nedir?'), q('Başka bir soru'), q('riemann-stieltjes  integralinin tanımı nedir')]);
	assert.deepEqual(r.kept.map((x) => x.question), ['Riemann-Stieltjes integralinin tanımı nedir?', 'Başka bir soru']);
	assert.equal(r.dropped.length, 1);
});

test('the same question across types (an MC stem reused as a statement) is one question', () => {
	const r = dedupeItems([{ question: 'Bir ağaçta her düğümün en fazla 2 çocuğu vardır', type: 'multiple_choice' }, { question: 'bir ağaçta her düğümün en fazla 2 çocuğu vardır.', type: 'true_false' }]);
	assert.equal(r.kept.length, 1);
	assert.equal(r.kept[0].type, 'multiple_choice');
});

test('"same template, different numbers" are DIFFERENT questions and must survive (this is what a fuzzy gate got wrong)', () => {
	const r = dedupeItems([
		q('∫ x² e^x dx integralini hesaplayınız.'),
		q('∫ x² dx integralini hesaplayınız.'),
		q('f(x) = 1/x fonksiyonunun x = 0 noktasındaki türevini hesaplayınız.'),
		q('f(x) = 1/x² fonksiyonunun x = 1 noktasındaki türevini hesaplayınız.'),
		q('Aşağıdaki fonksiyonun $x = 1$ noktasındaki türevini hesaplayınız: $f(x) = \\frac{1}{x^2}$'),
		q('Aşağıdaki fonksiyonun $x = 3$ noktasındaki türevini hesaplayınız: $f(x) = \\frac{1}{x^3}$')
	]);
	assert.equal(r.kept.length, 6);
	assert.equal(r.dropped.length, 0);
});

test('questions already accepted elsewhere count as seen (a top-up batch is checked against the quiz so far)', () => {
	const r = dedupeItems([q('Yeni soru'), q('Var olan soru')], ['var olan soru?']);
	assert.deepEqual(r.kept.map((x) => x.question), ['Yeni soru']);
});

test('nothing is dropped from an empty or all-distinct list', () => {
	assert.deepEqual(dedupeItems([]), { kept: [], dropped: [] });
	assert.equal(dedupeItems([q('a'), q('b'), q('c')]).dropped.length, 0);
});
