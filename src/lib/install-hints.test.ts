import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installHint, showWingetNote } from './install-hints';

test('macOS: Homebrew command where a formula exists, nothing for GUI apps', () => {
	assert.deepEqual(installHint('darwin', 'ollama'), { kind: 'brew', command: 'brew install ollama' });
	assert.deepEqual(installHint('darwin', 'llamacpp'), { kind: 'brew', command: 'brew install llama.cpp' });
	assert.deepEqual(installHint('darwin', 'python'), { kind: 'brew', command: 'brew install python@3.12' });
	assert.deepEqual(installHint('darwin', 'pandoc'), { kind: 'brew', command: 'brew install pandoc' });
	assert.deepEqual(installHint('darwin', 'lmstudio'), { kind: 'none' });
	assert.deepEqual(installHint('darwin', 'jan'), { kind: 'none' });
});

test('Linux: package-manager hint for python/pandoc/llama.cpp, never a pipe-to-shell for Ollama', () => {
	assert.deepEqual(installHint('linux', 'python'), { kind: 'package-manager' });
	assert.deepEqual(installHint('linux', 'pandoc'), { kind: 'package-manager' });
	assert.deepEqual(installHint('linux', 'llamacpp'), { kind: 'package-manager' });
	assert.deepEqual(installHint('linux', 'ollama'), { kind: 'none' });
});

test('Windows and unknown platforms get no hint; only Windows shows the winget note', () => {
	assert.deepEqual(installHint('win32', 'ollama'), { kind: 'none' });
	assert.deepEqual(installHint(null, 'ollama'), { kind: 'none' });
	assert.equal(showWingetNote('win32'), true);
	assert.equal(showWingetNote('darwin'), false);
	assert.equal(showWingetNote('linux'), false);
	assert.equal(showWingetNote(null), false);
});
