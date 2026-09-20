import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	canRetryResume,
	createSeamTrimmer,
	findCorruption,
	isCjkExpected,
	isCorruptedChunk,
	MAX_RESUMES,
	MIN_RESUME_CHARS,
	planRecovery,
	planSeam,
	RESUME_STOP,
	type RecoveryState
} from './resume-plan';

// ---------- findCorruption

test('clean Turkish and English text is not flagged', () => {
	assert.equal(findCorruption('Türkçe: ışık, şeker, ğüzel, İstanbul, çğöü. And plain English.', ['Türkçe']), null);
	assert.equal(isCorruptedChunk('', ['Türkçe']), false);
});

test('U+FFFD is found with its offset, at the start, middle and end', () => {
	assert.deepEqual(findCorruption('�abc', []), { index: 0, kind: 'fffd' });
	assert.deepEqual(findCorruption('abc�def', []), { index: 3, kind: 'fffd' });
	assert.deepEqual(findCorruption('abc�', []), { index: 3, kind: 'fffd' });
});

test('a CJK character is corruption in a vault that does not expect one', () => {
	assert.deepEqual(findCorruption('merhaba 你好 dünya', ['Türkçe']), { index: 8, kind: 'cjk' });
	assert.equal(isCorruptedChunk('merhaba 你好', ['Türkçe', 'English']), true);
});

test('the same character is legitimate when the vault allows a CJK language', () => {
	assert.equal(findCorruption('안녕 你好 こんにちは 漢字', ['Türkçe', 'Korece']), null);
	assert.equal(findCorruption('你好', ['Chinese']), null);
	assert.equal(isCjkExpected(['Türkçe']), false);
	assert.equal(isCjkExpected(['Japonca']), true);
});

test('U+FFFD stays corruption even in a CJK-friendly vault', () => {
	assert.deepEqual(findCorruption('你好�', ['Chinese']), { index: 2, kind: 'fffd' });
});

test('when both appear the earlier one wins', () => {
	assert.deepEqual(findCorruption('ab�你', []), { index: 2, kind: 'fffd' });
	assert.deepEqual(findCorruption('ab你�', []), { index: 2, kind: 'cjk' });
});

test('the CJK block boundaries are exactly U+4E00..U+9FFF', () => {
	assert.equal(isCorruptedChunk('一', []), true);
	assert.equal(isCorruptedChunk('鿿', []), true);
	assert.equal(isCorruptedChunk('䷿', []), false);
	assert.equal(isCorruptedChunk('ꀀ', []), false);
});

// ---------- planSeam

test('a partial word is cut back to the last whitespace and kept as the tail', () => {
	assert.deepEqual(planSeam('eşit yük'), { prompt: 'eşit', tail: ' yük' });
	assert.deepEqual(planSeam('Bir B-tree indeksi hızlı arama sağlar çün'), { prompt: 'Bir B-tree indeksi hızlı arama sağlar', tail: ' çün' });
});

test('text that already ends on whitespace is a finished prefix; the whitespace is the tail', () => {
	assert.deepEqual(planSeam('düğümler içerir. '), { prompt: 'düğümler içerir.', tail: ' ' });
	assert.deepEqual(planSeam('birinci paragraf.\n\n'), { prompt: 'birinci paragraf.', tail: '\n\n' });
});

test('the whole whitespace run before the partial word belongs to the tail', () => {
	assert.deepEqual(planSeam('a.\n\nBaşl'), { prompt: 'a.', tail: '\n\nBaşl' });
	assert.deepEqual(planSeam('word   par'), { prompt: 'word', tail: '   par' });
});

test('no usable boundary means no seam', () => {
	assert.equal(planSeam('tekkelime'), null);
	assert.equal(planSeam(''), null);
	assert.equal(planSeam('   '), null);
	assert.equal(planSeam(' x'), null);
});

test('prompt + tail always reproduces exactly what was displayed', () => {
	for (const s of ['eşit yük', 'a b c d', 'satır\nsonu ve dev', 'nokta. ', 'x  y  z', 'ğüşiöç kelime çok']) {
		const seam = planSeam(s);
		assert.ok(seam, `seam for ${JSON.stringify(s)}`);
		assert.equal(seam.prompt + seam.tail, s);
	}
});

// ---------- planRecovery

const LONG = 'kelime '.repeat(30).trimEnd() + ' par';
function state(over: Partial<RecoveryState> = {}): RecoveryState {
	return {
		where: 'text',
		thinkRequested: false,
		hasThinking: false,
		toolRoundTrips: 0,
		hopHadToolCall: false,
		resumesUsed: 0,
		displayed: LONG,
		supportsResume: true,
		...over
	};
}

test('the verified situation resumes, and returns the seam to use', () => {
	assert.ok(LONG.length >= MIN_RESUME_CHARS);
	const plan = planRecovery(state());
	assert.equal(plan.action, 'resume');
	if (plan.action === 'resume') assert.equal(plan.seam.prompt + plan.seam.tail, LONG);
});

test('every unverified situation keeps the old restart, with its reason', () => {
	const cases: [Partial<RecoveryState>, string][] = [
		[{ where: 'reasoning' }, 'reasoning'],
		[{ thinkRequested: true }, 'think-mode'],
		[{ hasThinking: true }, 'has-thinking'],
		[{ toolRoundTrips: 1 }, 'tool-round-trips'],
		[{ hopHadToolCall: true }, 'tool-call'],
		[{ supportsResume: false }, 'unsupported'],
		[{ resumesUsed: MAX_RESUMES }, 'resume-limit'],
		[{ displayed: 'kısa bir metin' }, 'too-short'],
		[{ displayed: 'x'.repeat(MIN_RESUME_CHARS) }, 'no-seam']
	];
	for (const [over, reason] of cases) {
		assert.deepEqual(planRecovery(state(over)), { action: 'restart', reason }, `case ${reason}`);
	}
});

test('one fewer resume than the limit is still allowed', () => {
	assert.equal(planRecovery(state({ resumesUsed: MAX_RESUMES - 1 })).action, 'resume');
});

test('the length threshold is inclusive', () => {
	const exactly = ('a '.repeat(MIN_RESUME_CHARS)).slice(0, MIN_RESUME_CHARS - 1) + 'b';
	assert.equal(exactly.length, MIN_RESUME_CHARS);
	assert.equal(planRecovery(state({ displayed: exactly })).action, 'resume');
	assert.deepEqual(planRecovery(state({ displayed: exactly.slice(1) })), { action: 'restart', reason: 'too-short' });
});

test('RESUME_STOP contains the strings that end a fake think block', () => {
	assert.ok(RESUME_STOP.includes('</think>'));
	assert.ok(RESUME_STOP.includes('<think>'));
});

// ---------- createSeamTrimmer

function run(tail: string, chunks: string[]) {
	const t = createSeamTrimmer(tail);
	let shown = '';
	let status: string = 'pending';
	for (const c of chunks) {
		const r = t.push(c);
		shown += r.emit;
		status = r.status;
		if (r.status === 'mismatch') return { status, shown };
	}
	const f = t.finish();
	return { status: f.status, shown: shown + f.emit };
}

test('a partial-word tail reproduced in one chunk is stripped', () => {
	assert.deepEqual(run(' yük', [' yükseklikte düğümler']), { status: 'ok', shown: 'seklikte düğümler' });
});

test('the tail may arrive split across several chunks', () => {
	assert.deepEqual(run(' yük', [' ', 'y', 'ük', 'sek', 'lik']), { status: 'ok', shown: 'seklik' });
});

test('nothing is emitted until the tail has been matched', () => {
	const t = createSeamTrimmer(' yük');
	assert.deepEqual(t.push(' y'), { status: 'pending', emit: '' });
	assert.deepEqual(t.push('ü'), { status: 'pending', emit: '' });
	assert.deepEqual(t.push('kseklikte'), { status: 'ok', emit: 'seklikte' });
	assert.deepEqual(t.push(' devam'), { status: 'ok', emit: ' devam' });
});

test('a different word is a mismatch — the caller must restart', () => {
	assert.equal(run(' yük', [' taşıdığından']).status, 'mismatch');
	assert.equal(run(' yük', [' ta', 'şı']).status, 'mismatch');
	assert.equal(run(' yük', ['yük']).status, 'mismatch'); // missing the leading space of the tail
});

test('a mismatch is sticky and never emits', () => {
	const t = createSeamTrimmer(' yük');
	assert.equal(t.push(' zzz').status, 'mismatch');
	assert.deepEqual(t.push(' yükseklik'), { status: 'mismatch', emit: '' });
	assert.deepEqual(t.finish(), { status: 'mismatch', emit: '' });
});

test('a stream that ends before the partial word was reproduced is a mismatch', () => {
	assert.deepEqual(run(' yükseklik', [' yük']), { status: 'mismatch', shown: '' });
	assert.deepEqual(run(' yük', []), { status: 'mismatch', shown: '' });
});

test('a whitespace tail drops the whitespace the model repeats', () => {
	assert.deepEqual(run(' ', [' Bu yapı']), { status: 'ok', shown: 'Bu yapı' });
	assert.deepEqual(run(' ', ['Bu yapı']), { status: 'ok', shown: 'Bu yapı' }); // model did not repeat it
	assert.deepEqual(run('\n\n', ['\n\n## Başlık', ' devam']), { status: 'ok', shown: '## Başlık devam' });
});

test('a whitespace tail waits through whitespace-only chunks', () => {
	const t = createSeamTrimmer(' ');
	assert.deepEqual(t.push(' '), { status: 'pending', emit: '' });
	assert.deepEqual(t.push('\n'), { status: 'pending', emit: '' });
	assert.deepEqual(t.push('Sonra'), { status: 'ok', emit: 'Sonra' });
});

test('a whitespace tail with an empty continuation is fine — the model had nothing to add', () => {
	assert.deepEqual(run(' ', []), { status: 'ok', shown: '' });
	assert.deepEqual(run(' ', [' ', '  ']), { status: 'ok', shown: '' });
});

test('user-visible text stays continuous: displayed + emitted equals the intended answer', () => {
	const displayed = 'B-tree, dengeli ağaç yapısı sayesinde her seviyede eşit yük';
	const seam = planSeam(displayed);
	assert.ok(seam);
	const modelStream = [' yük', 'sek', 'likte', ' düğümler', ' içerir.'];
	const { status, shown } = run(seam.tail, modelStream);
	assert.equal(status, 'ok');
	assert.equal(displayed + shown, 'B-tree, dengeli ağaç yapısı sayesinde her seviyede eşit yükseklikte düğümler içerir.');
});

// ---------- canRetryResume

test('a missed seam is retried until the shared resume budget is used up', () => {
	assert.equal(canRetryResume(0), true);
	assert.equal(canRetryResume(MAX_RESUMES - 1), true);
	assert.equal(canRetryResume(MAX_RESUMES), false);
	assert.equal(canRetryResume(MAX_RESUMES + 5), false);
});
