import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAutoConfirmMode, shouldAutoConfirm, type AutoConfirmCandidate } from './mcp-auto-confirm-policy';

const base: AutoConfirmCandidate = {
	status: 'ready',
	by: 'mcp',
	warnings: [],
	needsReview: false,
	proposed: { title: 'Sema', domain: 'genel' }
};

test('parseAutoConfirmMode accepts exactly the three modes', () => {
	assert.equal(parseAutoConfirmMode('off'), 'off');
	assert.equal(parseAutoConfirmMode('clean'), 'clean');
	assert.equal(parseAutoConfirmMode('all'), 'all');
});

test('parseAutoConfirmMode rejects everything else (no coercion)', () => {
	for (const bad of ['', 'ALL', ' all', 'all ', 'true', 'yes', true, false, 1, null, undefined, {}, ['all'], 'clean\u0000']) {
		assert.equal(parseAutoConfirmMode(bad), undefined, String(bad));
	}
});

test('off never confirms', () => {
	assert.equal(shouldAutoConfirm('off', base), false);
});

test('clean: only ready + no warnings + no needs_review', () => {
	assert.equal(shouldAutoConfirm('clean', base), true);
	assert.equal(shouldAutoConfirm('clean', { ...base, warnings: ['IMPORT_DUPLICATE_CONTENT'] }), false);
	assert.equal(shouldAutoConfirm('clean', { ...base, warnings: ['IMPORT_DUPLICATE_URL'] }), false);
	assert.equal(shouldAutoConfirm('clean', { ...base, warnings: ['SOME_CONVERTER_WARNING'] }), false);
	assert.equal(shouldAutoConfirm('clean', { ...base, needsReview: true }), false);
});

test('all: confirms ready imports even with warnings or needs_review', () => {
	assert.equal(shouldAutoConfirm('all', { ...base, warnings: ['IMPORT_DUPLICATE_CONTENT'] }), true);
	assert.equal(shouldAutoConfirm('all', { ...base, needsReview: true }), true);
});

test('errors and non-ready states are never confirmed, in any mode', () => {
	for (const mode of ['clean', 'all'] as const) {
		for (const status of ['queued', 'converting', 'error']) {
			assert.equal(shouldAutoConfirm(mode, { ...base, status }), false, `${mode}/${status}`);
		}
		assert.equal(shouldAutoConfirm(mode, { ...base, error: { code: 'X' } }), false);
	}
});

test('imports made in the app (by: app) are never auto-confirmed', () => {
	assert.equal(shouldAutoConfirm('all', { ...base, by: 'app' }), false);
	assert.equal(shouldAutoConfirm('clean', { ...base, by: 'app' }), false);
});

test('a blank proposed title or domain stays pending for a human', () => {
	assert.equal(shouldAutoConfirm('all', { ...base, proposed: { title: '  ', domain: 'genel' } }), false);
	assert.equal(shouldAutoConfirm('all', { ...base, proposed: { title: 'T', domain: '' } }), false);
	assert.equal(shouldAutoConfirm('all', { ...base, proposed: {} }), false);
});
