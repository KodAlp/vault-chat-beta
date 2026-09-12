import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRetrievalQuery } from './retrieval-query';
import type { ChatMessage } from '$lib/types';

function user(content: string): ChatMessage {
	return { role: 'user', content } as ChatMessage;
}
function assistant(content: string): ChatMessage {
	return { role: 'assistant', content } as ChatMessage;
}

// Regression coverage for the real failing conversation: the first question
// ("Selam bana türev anlat") was still generating when two more user
// messages arrived before it answered, so the query embedded for retrieval
// was the THIRD message alone — an interjection that names no topic — and
// search returned unrelated domains. buildRetrievalQuery must carry the
// nearest actual topic forward instead of embedding one bare turn.

test('a single user turn is returned as-is', () => {
	assert.equal(buildRetrievalQuery([user('türev nedir')]), 'türev nedir');
});

test('an on-topic message followed by a content-free interjection still carries the topic', () => {
	const messages = [user('Selam bana türev anlat'), user('eeee cevap nerde amk'), user('oe bi cevap verecen ananı')];
	const query = buildRetrievalQuery(messages);
	assert.match(query, /türev/i, 'the actual topic survives into the embedded query');
});

test('assistant turns are not embedded, only user turns count toward the window', () => {
	const messages = [user('lineer cebir nedir'), assistant('Cevap burada...'), user('daha basit anlat')];
	const query = buildRetrievalQuery(messages);
	assert.match(query, /lineer cebir/i);
	assert.match(query, /daha basit anlat/i);
});

test('the last message is always included in full and appended last', () => {
	const query = buildRetrievalQuery([user('convex optimization'), user('explain the KKT conditions')]);
	assert.ok(query.endsWith('explain the KKT conditions'));
});

test('an oversized earlier turn is skipped rather than truncated into the query', () => {
	const huge = 'x'.repeat(500);
	const query = buildRetrievalQuery([user(huge), user('kısa soru')]);
	assert.equal(query, 'kısa soru');
});

test('a repeated identical message does not duplicate itself in the query', () => {
	const query = buildRetrievalQuery([user('türev nedir'), user('türev nedir')]);
	assert.equal(query, 'türev nedir');
});

test('no user turns yields an empty query rather than throwing', () => {
	assert.equal(buildRetrievalQuery([assistant('merhaba')]), '');
});

test('empty message history yields an empty query', () => {
	assert.equal(buildRetrievalQuery([]), '');
});
