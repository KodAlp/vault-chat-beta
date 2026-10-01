import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoSourcesError, assertNoEmbeddingIssue } from './generate-errors';
import { AppError } from './app-error';
import type { RetrieveResult } from '$lib/types';

test('assertNoEmbeddingIssue does nothing when embeddingIssue is absent', () => {
	const result: RetrieveResult = { chunks: [], narrowScope: false };
	assert.doesNotThrow(() => assertNoEmbeddingIssue(result));
});

test('assertNoEmbeddingIssue does NOT throw for a deliberate "fts-only" configuration, whether or not keyword hits were found', () => {
	const hit = { path: 'a.md', heading_path: 'h', display_text: 't', topic: 't', depth: 'undergrad', domains: [], distance: 1, via: 'keyword' as const };
	assert.doesNotThrow(() => assertNoEmbeddingIssue({ chunks: [hit], narrowScope: false, keyword: true, embeddingIssue: 'fts-only' }));
	assert.doesNotThrow(() => assertNoEmbeddingIssue({ chunks: [], narrowScope: false, reason: 'fts-only', embeddingIssue: 'fts-only' }));
});

test('assertNoEmbeddingIssue throws EMBEDDING_MISMATCH for a "mismatch" issue, even with non-empty chunks', () => {
	const result: RetrieveResult = {
		chunks: [{ path: 'a.md', heading_path: 'h', display_text: 't', topic: 't', depth: 'undergrad', domains: [], distance: 1, via: 'keyword' }],
		narrowScope: false,
		embeddingIssue: 'mismatch'
	};
	assert.throws(() => assertNoEmbeddingIssue(result), (err: unknown) => {
		assert.ok(err instanceof AppError);
		assert.equal(err.code, 'EMBEDDING_MISMATCH');
		return true;
	});
});

test('assertNoEmbeddingIssue throws EMBEDDING_UNAVAILABLE for an "unavailable" issue', () => {
	const result: RetrieveResult = { chunks: [], narrowScope: false, embeddingIssue: 'unavailable' };
	assert.throws(() => assertNoEmbeddingIssue(result), (err: unknown) => {
		assert.ok(err instanceof AppError);
		assert.equal(err.code, 'EMBEDDING_UNAVAILABLE');
		return true;
	});
});

test('NoSourcesError still carries narrowScope/reason exactly as before (unaffected by the embedding-issue check)', () => {
	const err = new NoSourcesError(true, 'scope');
	assert.equal(err.narrowScope, true);
	assert.equal(err.reason, 'scope');
});
