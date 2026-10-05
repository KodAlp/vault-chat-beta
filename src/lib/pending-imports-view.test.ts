import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionCount, hasActiveImports } from './pending-imports-view';
import type { PendingImportItem } from './types';

const item = (status: PendingImportItem['status']): PendingImportItem => ({
	importId: status,
	status,
	source: { kind: 'path', name: 'a.pdf' },
	proposed: { title: 't', domain: 'd', level: 'undergraduate' },
	warnings: [],
	by: 'mcp',
	createdAt: '',
	updatedAt: ''
});

test('hasActiveImports is true only while something is queued or converting', () => {
	assert.equal(hasActiveImports([]), false);
	assert.equal(hasActiveImports([item('ready'), item('error')]), false);
	assert.equal(hasActiveImports([item('ready'), item('converting')]), true);
	assert.equal(hasActiveImports([item('queued')]), true);
});

test('attentionCount counts ready and error only', () => {
	assert.equal(attentionCount([item('queued'), item('converting')]), 0);
	assert.equal(attentionCount([item('ready'), item('error'), item('queued')]), 2);
});
