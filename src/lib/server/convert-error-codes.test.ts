import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardedConvertCode } from './convert-error-codes';

test('PDF_DAMAGED is forwarded', () => {
	assert.equal(forwardedConvertCode('PDF_DAMAGED'), 'PDF_DAMAGED');
});

test('unknown, other known, and non-string codes are not forwarded', () => {
	assert.equal(forwardedConvertCode('FILE_TOO_LARGE'), null);
	assert.equal(forwardedConvertCode('CONVERSION_FAILED'), null);
	assert.equal(forwardedConvertCode('whatever'), null);
	assert.equal(forwardedConvertCode(undefined), null);
	assert.equal(forwardedConvertCode(42), null);
	assert.equal(forwardedConvertCode({}), null);
});
