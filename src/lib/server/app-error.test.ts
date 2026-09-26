import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, toCodedError, errorPayload } from './app-error';
import { ProviderError } from './providers/types';
import { NoSourcesError } from './generate-errors';

test('toCodedError(AppError) returns its own code/params', () => {
	const err = new AppError('NOT_FOUND', { entity: 'quiz' }, 404);
	assert.deepEqual(toCodedError(err), { code: 'NOT_FOUND', params: { entity: 'quiz' } });
});

test('toCodedError(AppError) with no params omits params', () => {
	const err = new AppError('INTERNAL');
	assert.deepEqual(toCodedError(err), { code: 'INTERNAL', params: undefined });
});

test('toCodedError(ProviderError) maps each kind to PROVIDER_<KIND> with provider/detail params', () => {
	const kinds = [
		'network',
		'timeout_connect',
		'timeout_first_token',
		'timeout_idle',
		'http_429',
		'http_5xx',
		'auth',
		'bad_request',
		'context_length',
		'unknown'
	] as const;

	for (const kind of kinds) {
		const err = new ProviderError(kind, 'groq', 'boom: ' + kind);
		const coded = toCodedError(err);
		assert.equal(coded.code, 'PROVIDER_' + kind.toUpperCase());
		assert.deepEqual(coded.params, { provider: 'groq', detail: 'boom: ' + kind });
	}
});

test('toCodedError(NoSourcesError) with narrowScope=true -> NO_SOURCES_NARROW, no params', () => {
	const err = new NoSourcesError(true);
	assert.deepEqual(toCodedError(err), { code: 'NO_SOURCES_NARROW' });
});

test('toCodedError(NoSourcesError) with narrowScope=false -> NO_SOURCES, no params', () => {
	const err = new NoSourcesError(false);
	assert.deepEqual(toCodedError(err), { code: 'NO_SOURCES' });
});

test('toCodedError on a SvelteKit HttpError-like object with body.code returns that code/params', () => {
	const httpErrorLike = { status: 400, body: { message: 'VALIDATION_REQUIRED', code: 'VALIDATION_REQUIRED', params: { field: 'title' } } };
	assert.deepEqual(toCodedError(httpErrorLike), { code: 'VALIDATION_REQUIRED', params: { field: 'title' } });
});

test('toCodedError on an uncoded HttpError-like object keeps its message as detail', () => {
	const httpErrorLike = { status: 400, body: { message: 'legacy text' } };
	assert.deepEqual(toCodedError(httpErrorLike), { code: 'UNKNOWN', params: { detail: 'legacy text' } });
});

test('toCodedError on a plain Error -> UNKNOWN with the message as detail', () => {
	const err = new Error('disk full');
	assert.deepEqual(toCodedError(err), { code: 'UNKNOWN', params: { detail: 'disk full' } });
});

test('toCodedError on a thrown string (non-Error) -> UNKNOWN, no params', () => {
	assert.deepEqual(toCodedError('a raw string throw'), { code: 'UNKNOWN' });
});

test('errorPayload includes message set to the code, alongside code/params', () => {
	const err = new AppError('NOT_FOUND', { entity: 'chat' }, 404);
	assert.deepEqual(errorPayload(err), { code: 'NOT_FOUND', params: { entity: 'chat' }, message: 'NOT_FOUND' });
});

test('errorPayload on an unknown error still has message === code', () => {
	assert.deepEqual(errorPayload(new Error('x')), { code: 'UNKNOWN', params: { detail: 'x' }, message: 'UNKNOWN' });
});
