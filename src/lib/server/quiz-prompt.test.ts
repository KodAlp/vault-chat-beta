import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBatchUserPrompt, LEVEL_GUIDE } from './quiz-prompt';
import { buildQuizItemsJsonSchema } from './quiz-schema';
import { validateQuizBatch } from './quiz-validate';
import { assignLevels } from '../cognitive-levels';

// The prompt exactly as generate-quiz.ts built it at commit bc999bf, BEFORE cognitive levels existed. A user who never turns
// Settings.quizLevelLabels on must get this text and nothing else.
const legacy = (userPrompt: string, typeTr: string, slots: string[]) =>
	`${userPrompt}\n\nBu partideki TÜM sorular ${typeTr} türünde olmalı.` +
	`\n\nHer sorunun kaynağı sabittir; sırayla: ${slots.map((id, i) => `${i + 1}. soru ${id}`).join(', ')}. ` +
	`Her soruyu YALNIZCA kendi kimliğinin içeriğinden üret ve source_id alanına o kimliği yaz.`;

test('levels OFF: the batch prompt is byte-identical to the one before levels existed, for every type', () => {
	const slots = ['S1', 'S5', 'S9'];
	assert.equal(buildBatchUserPrompt('Türev ve integral', 'multiple_choice', slots), legacy('Türev ve integral', 'çoktan seçmeli', slots));
	assert.equal(buildBatchUserPrompt('Türev ve integral', 'true_false', slots), legacy('Türev ve integral', 'doğru/yanlış', slots));
	assert.equal(buildBatchUserPrompt('Türev ve integral', 'open', slots), legacy('Türev ve integral', 'açık uçlu', slots));
	assert.equal(buildBatchUserPrompt('x', 'open', ['S2']), legacy('x', 'açık uçlu', ['S2']));
});

test('levels OFF: nothing about levels reaches the prompt', () => {
	const p = buildBatchUserPrompt('konu', 'open', ['S1', 'S2']);
	assert.equal(/cognitive_level|düzey|recall|application|higher/i.test(p), false);
});

test('levels ON: each question names its level, the field is asked for, and the guide is appended', () => {
	const levels = assignLevels('open', 3, [true, false, true]);
	const p = buildBatchUserPrompt('konu', 'open', ['S1', 'S2', 'S3'], levels);
	assert.match(p, /1\. soru S1 \(application düzeyinde\), 2\. soru S2 \(higher düzeyinde\), 3\. soru S3 \(understanding düzeyinde\)/);
	assert.match(p, /cognitive_level alanına/);
	assert.ok(p.endsWith(LEVEL_GUIDE));
	assert.ok(p.startsWith('konu\n\nBu partideki TÜM sorular açık uçlu türünde olmalı.'), 'the type line is still first');
	assert.match(p, /Her soruyu YALNIZCA kendi kimliğinin içeriğinden üret ve source_id alanına o kimliği yaz\./, 'the source rule is still there');
});

test('levels OFF: the grammar has no cognitive_level anywhere and is unchanged', () => {
	const off = buildQuizItemsJsonSchema(['S1', 'S2'], 2, 'multiple_choice', ['S1', 'S2']);
	assert.equal(JSON.stringify(off).includes('cognitive_level'), false);
	assert.deepEqual(off, buildQuizItemsJsonSchema(['S1', 'S2'], 2, 'multiple_choice', ['S1', 'S2'], undefined));
});

test('levels ON: the grammar requires the level and pins one level per position', () => {
	const on = buildQuizItemsJsonSchema(['S1', 'S2'], 2, 'open', ['S1', 'S2'], ['application', 'higher']) as unknown as {
		properties: { items: { prefixItems: { properties: Record<string, { enum?: string[] }>; required: string[] }[] } };
	};
	const [first, second] = on.properties.items.prefixItems;
	assert.deepEqual(first.properties.cognitive_level.enum, ['application']);
	assert.deepEqual(second.properties.cognitive_level.enum, ['higher']);
	assert.ok(first.required.includes('cognitive_level'));
	// generated in property order: the level is committed to BEFORE the question is written
	const keys = Object.keys(first.properties);
	assert.ok(keys.indexOf('cognitive_level') < keys.indexOf('question'), keys.join(','));
});

test('the validator keeps the level only when levels were asked for, and rejects one that is not the assigned level', () => {
	const chunks = new Map([['S1', { path: 'a.md', heading_path: 'A > x' }]]);
	const item = (level?: string) => JSON.stringify({ items: [{ type: 'open', question: 'q', answer: 'a', explanation: 'e', source_id: 'S1', ...(level ? { cognitive_level: level } : {}) }] });
	const off = validateQuizBatch(item(), { idToChunk: chunks, expectedCount: 1 });
	assert.ok(off.ok);
	assert.equal('cognitiveLevel' in off.items[0], false, 'no level key at all when levels are off');
	const on = validateQuizBatch(item('higher'), { idToChunk: chunks, expectedCount: 1, levels: ['higher'] });
	assert.ok(on.ok);
	assert.equal(on.items[0].cognitiveLevel, 'higher');
	const wrong = validateQuizBatch(item('recall'), { idToChunk: chunks, expectedCount: 1, levels: ['higher'] });
	assert.equal(wrong.ok, false);
	assert.equal(!wrong.ok && wrong.code, 'level');
	assert.equal(validateQuizBatch(item(), { idToChunk: chunks, expectedCount: 1, levels: ['higher'] }).ok, false, 'a missing level is rejected when one was asked for');
});
