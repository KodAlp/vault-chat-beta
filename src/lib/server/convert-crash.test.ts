import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNativeCrash, runWithCrashRetry, type AttemptOutcome } from './convert-crash';
import { AppError } from './app-error';

test('isNativeCrash: Windows NTSTATUS crashes', () => {
	assert.equal(isNativeCrash(3221226356, null), true); // 0xC0000374
	assert.equal(isNativeCrash(3221225477, null), true); // 0xC0000005
	assert.equal(isNativeCrash(0xc0000409, null), true);
	// Signed 32-bit form of the same status
	assert.equal(isNativeCrash(-1073740940, null), true);
});

test('isNativeCrash: deterministic or ordinary exits are not crashes', () => {
	assert.equal(isNativeCrash(3221225794, null), false); // 0xC0000142 DLL init
	assert.equal(isNativeCrash(1, null), false);
	assert.equal(isNativeCrash(0, null), false);
	assert.equal(isNativeCrash(null, null), false);
});

test('isNativeCrash: POSIX signals', () => {
	assert.equal(isNativeCrash(null, 'SIGSEGV'), true);
	assert.equal(isNativeCrash(null, 'SIGBUS'), true);
	assert.equal(isNativeCrash(null, 'SIGABRT'), true);
	assert.equal(isNativeCrash(null, 'SIGILL'), true);
	assert.equal(isNativeCrash(null, 'SIGTERM'), false);
	assert.equal(isNativeCrash(null, 'SIGKILL'), false);
});

function sequence(outcomes: AttemptOutcome<string>[]) {
	let calls = 0;
	const seen: number[] = [];
	return {
		attempt: async (n: 0 | 1) => {
			seen.push(n);
			return outcomes[calls++];
		},
		calls: () => calls,
		attemptNumbers: () => seen
	};
}

test('crash then done resolves and retries exactly once', async () => {
	const s = sequence([{ kind: 'crash', detail: 'exit 1' }, { kind: 'done', value: 'ok' }]);
	let retries = 0;
	assert.equal(await runWithCrashRetry(s.attempt, () => retries++), 'ok');
	assert.equal(s.calls(), 2);
	assert.equal(retries, 1);
});

test('the retry gets attempt number 1 (fallback backend), the first 0', async () => {
	const s = sequence([{ kind: 'crash', detail: 'exit 1' }, { kind: 'done', value: 'ok' }]);
	await runWithCrashRetry(s.attempt, () => {});
	assert.deepEqual(s.attemptNumbers(), [0, 1]);
});

test('without a crash only attempt 0 runs', async () => {
	const s = sequence([{ kind: 'done', value: 'ok' }]);
	await runWithCrashRetry(s.attempt, () => {});
	assert.deepEqual(s.attemptNumbers(), [0]);
});

test('crash then crash becomes CONVERTER_CRASHED', async () => {
	const s = sequence([
		{ kind: 'crash', detail: 'first' },
		{ kind: 'crash', detail: 'second' }
	]);
	let retries = 0;
	await assert.rejects(
		runWithCrashRetry(s.attempt, () => retries++),
		(e) => e instanceof AppError && e.code === 'CONVERTER_CRASHED'
	);
	assert.equal(s.calls(), 2);
	assert.equal(retries, 1);
});

test('an error outcome is not retried', async () => {
	const s = sequence([{ kind: 'error', error: new AppError('CONVERSION_FAILED', { detail: 'x' }) }]);
	let retries = 0;
	await assert.rejects(
		runWithCrashRetry(s.attempt, () => retries++),
		(e) => e instanceof AppError && e.code === 'CONVERSION_FAILED'
	);
	assert.equal(s.calls(), 1);
	assert.equal(retries, 0);
});

test('done on the first attempt makes a single attempt', async () => {
	const s = sequence([{ kind: 'done', value: 'ok' }]);
	let retries = 0;
	assert.equal(await runWithCrashRetry(s.attempt, () => retries++), 'ok');
	assert.equal(s.calls(), 1);
	assert.equal(retries, 0);
});

test('a timeout is not retried', async () => {
	const s = sequence([{ kind: 'error', error: new AppError('PROCESS_TIMEOUT', { seconds: 60 }) }]);
	let retries = 0;
	await assert.rejects(
		runWithCrashRetry(s.attempt, () => retries++),
		(e) => e instanceof AppError && e.code === 'PROCESS_TIMEOUT'
	);
	assert.equal(s.calls(), 1);
	assert.equal(retries, 0);
});
