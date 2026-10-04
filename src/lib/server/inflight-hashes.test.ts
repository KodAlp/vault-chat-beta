import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInflightHashes } from './inflight-hashes';

test('second reservation of the same hash in the same vault is refused', () => {
	const r = createInflightHashes();
	assert.equal(r.reserve('v1', 'abc'), true);
	assert.equal(r.reserve('v1', 'abc'), false);
});

test('different hashes and different vaults do not collide', () => {
	const r = createInflightHashes();
	assert.equal(r.reserve('v1', 'abc'), true);
	assert.equal(r.reserve('v1', 'def'), true);
	assert.equal(r.reserve('v2', 'abc'), true);
});

test('release frees the hash for a later reservation', () => {
	const r = createInflightHashes();
	r.reserve('v1', 'abc');
	r.release('v1', 'abc');
	assert.equal(r.reserve('v1', 'abc'), true);
});

test('releasing something never reserved is harmless', () => {
	const r = createInflightHashes();
	r.release('nope', 'abc');
	assert.equal(r.reserve('nope', 'abc'), true);
});
