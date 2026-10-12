import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTitleSystemPrompt } from './title-prompt';

test('title prompt names English for an English question', () => {
	const p = buildTitleSystemPrompt('How does a B-tree keep itself balanced when inserting new keys?');
	assert.ok(p.includes('in English'));
	assert.ok(!p.includes('Turkish'));
});

test('title prompt names Turkish for a Turkish question', () => {
	const p = buildTitleSystemPrompt('B-ağacı yeni anahtar eklenirken dengesini nasıl korur, açıklar mısın?');
	assert.ok(p.includes('in Turkish'));
});

test('title prompt falls back to the primary language for a very short question', () => {
	assert.ok(buildTitleSystemPrompt('hi', 'German').includes('in German'));
});
