import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { detectLineSeparator } from './line-separator';

function roundTrip(text: string): string {
	const sep = detectLineSeparator(text);
	const state = EditorState.create({
		doc: text,
		extensions: sep ? [EditorState.lineSeparator.of(sep)] : []
	});
	return state.sliceDoc(0);
}

test('detect: pure CRLF, LF, mixed, none', () => {
	assert.equal(detectLineSeparator('a\r\nb\r\n'), '\r\n');
	assert.equal(detectLineSeparator('a\nb\n'), undefined);
	assert.equal(detectLineSeparator('no breaks'), undefined);
	assert.equal(detectLineSeparator(''), undefined);
	assert.equal(detectLineSeparator('a\r\nb\nc\r\n'), '\n');
	assert.equal(detectLineSeparator('a\rb'), '\n');
});

test('round trip through CodeMirror keeps the original bytes', () => {
	for (const s of ['a\r\nb\r\n', 'a\nb\n', 'a\r\nb\nc\r\n', 'a\rb\r\n', '', 'x']) {
		assert.equal(roundTrip(s), s);
	}
});
