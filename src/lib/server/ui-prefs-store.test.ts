import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUiPrefs, writeUiPrefs } from './ui-prefs-store';

function useTmpDataDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-prefs-test-'));
	process.env.DATA_DIR = dir;
	return dir;
}

test('a fresh DATA_DIR with no file yet reads back as empty', () => {
	useTmpDataDir();
	assert.deepEqual(readUiPrefs(), {});
});

test('writeUiPrefs round-trips locale and settings through a fresh read', () => {
	useTmpDataDir();
	writeUiPrefs({ locale: 'en', settings: { theme: 'dark', defaultModel: 'qwen3:8b' } });
	assert.deepEqual(readUiPrefs(), { locale: 'en', settings: { theme: 'dark', defaultModel: 'qwen3:8b' } });
});

test('an invalid locale is dropped, a valid one is kept', () => {
	useTmpDataDir();
	// @ts-expect-error — intentionally passing a bad value, this is exactly
	// what an untrusted PUT body could contain.
	writeUiPrefs({ locale: 'fr' });
	assert.deepEqual(readUiPrefs(), {});

	writeUiPrefs({ locale: 'tr' });
	assert.deepEqual(readUiPrefs(), { locale: 'tr' });
});

test('an invalid theme is dropped but other valid settings fields survive', () => {
	useTmpDataDir();
	writeUiPrefs({
		settings: {
			// @ts-expect-error — intentionally invalid, same untrusted-body case.
			theme: 'purple',
			defaultProvider: 'ollama'
		}
	});
	assert.deepEqual(readUiPrefs(), { settings: { defaultProvider: 'ollama' } });
});

test('a non-boolean value for a boolean field is dropped', () => {
	useTmpDataDir();
	writeUiPrefs({
		// @ts-expect-error — intentionally wrong type, same untrusted-body case.
		settings: { allowConcurrentGeneration: 'yes', showWelcomeScreen: true }
	});
	assert.deepEqual(readUiPrefs(), { settings: { showWelcomeScreen: true } });
});

test('a model/provider string over 200 chars is dropped; an empty one is kept (it means "no pin")', () => {
	useTmpDataDir();
	writeUiPrefs({
		settings: {
			defaultModel: 'x'.repeat(201),
			fastModel: '',
			reasoningModel: 'qwen3:8b'
		}
	});
	assert.deepEqual(readUiPrefs(), { settings: { fastModel: '', reasoningModel: 'qwen3:8b' } });
});

test('clearing a saved model to "" overwrites the earlier value instead of leaving it behind', () => {
	useTmpDataDir();
	writeUiPrefs({ settings: { defaultModel: 'qwen3:8b', defaultProvider: 'ollama' } });
	writeUiPrefs({ settings: { defaultModel: '', defaultProvider: '' } });
	assert.deepEqual(readUiPrefs(), { settings: { defaultModel: '', defaultProvider: '' } });
});

test('unknown keys at either level are dropped silently, not thrown', () => {
	useTmpDataDir();
	// Cast at the call site rather than @ts-expect-error per property — this
	// intentionally violates UiPrefs's shape at two nesting levels at once
	// (an outer `bogus` field and a nested `notARealField`), which is
	// exactly the untrusted-PUT-body shape sanitizeSettings() exists to
	// handle.
	writeUiPrefs({
		bogus: 'nope',
		locale: 'tr',
		settings: { theme: 'light', notARealField: 123 }
	} as unknown as Parameters<typeof writeUiPrefs>[0]);
	assert.deepEqual(readUiPrefs(), { locale: 'tr', settings: { theme: 'light' } });
});

test('a corrupt file on disk reads back as empty, never throws', () => {
	const dir = useTmpDataDir();
	fs.writeFileSync(path.join(dir, 'ui-prefs.json'), '{ not valid json', 'utf-8');
	assert.deepEqual(readUiPrefs(), {});
});

test('a missing file (DATA_DIR exists but no ui-prefs.json yet) reads back as empty', () => {
	useTmpDataDir();
	assert.equal(fs.existsSync(path.join(process.env.DATA_DIR!, 'ui-prefs.json')), false);
	assert.deepEqual(readUiPrefs(), {});
});

test('locale replaces on a second write, settings shallow-merges instead of clobbering', () => {
	useTmpDataDir();
	writeUiPrefs({ locale: 'tr', settings: { theme: 'dark', defaultModel: 'qwen3:8b' } });
	writeUiPrefs({ locale: 'en', settings: { theme: 'light' } });
	assert.deepEqual(readUiPrefs(), {
		locale: 'en',
		// theme was overwritten, defaultModel from the first write survives —
		// a PUT that only changes one field must not wipe the rest.
		settings: { theme: 'light', defaultModel: 'qwen3:8b' }
	});
});

test('writing settings alone does not touch an already-stored locale', () => {
	useTmpDataDir();
	writeUiPrefs({ locale: 'en' });
	writeUiPrefs({ settings: { theme: 'dark' } });
	assert.deepEqual(readUiPrefs(), { locale: 'en', settings: { theme: 'dark' } });
});

test('the file on disk survives a write intact (atomic tmp+rename leaves no stray .tmp file)', () => {
	const dir = useTmpDataDir();
	writeUiPrefs({ locale: 'en' });
	const strays = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
	assert.deepEqual(strays, []);
});

test('localServerSetupDone round-trips and survives a locale-only write', () => {
	useTmpDataDir();
	writeUiPrefs({ localServerSetupDone: true });
	assert.deepEqual(readUiPrefs(), { localServerSetupDone: true });

	// A later write that only touches locale must not silently reset the
	// flag back to unset — same "don't clobber the rest" rule settings
	// shallow-merging already enforces above.
	writeUiPrefs({ locale: 'en' });
	assert.deepEqual(readUiPrefs(), { locale: 'en', localServerSetupDone: true });
});

test('localServerSetupDone: false explicitly wins over a stored true (not treated as falsy/absent)', () => {
	useTmpDataDir();
	writeUiPrefs({ localServerSetupDone: true });
	writeUiPrefs({ localServerSetupDone: false });
	assert.deepEqual(readUiPrefs(), { localServerSetupDone: false });
});

test('a non-boolean localServerSetupDone is dropped, not coerced', () => {
	useTmpDataDir();
	writeUiPrefs({
		// @ts-expect-error — intentionally wrong type, same untrusted-body case.
		localServerSetupDone: 'true'
	});
	assert.deepEqual(readUiPrefs(), {});
});
