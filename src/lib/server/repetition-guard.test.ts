import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeOpenFence, findRepetitionLoop, findStrayThinkClose } from './repetition-guard';

const PARA =
	'Bu paragraf modelin takıldığı döngüdür ve aynen tekrar eder; uzunluğu iki yüz karakteri rahatça aşıyor ki kuyruk eşleşmesi çalışsın. ' +
	'İkinci cümle de aynı paragrafın parçasıdır ve her turda birebir yinelenir.\n\n';

test('periodic paragraph loop: cut keeps exactly one copy', () => {
	const intro = 'Giriş cümlesi burada başlar.\n\n';
	const text = intro + PARA.repeat(6);
	const hit = findRepetitionLoop(text);
	assert.ok(hit);
	const kept = text.slice(0, hit.cutAt).trimEnd();
	// paragraph ending (a few characters), so the cut may drop a few trailing characters of the copy.
	const one = intro + PARA;
	assert.ok(one.startsWith(kept));
	assert.ok(kept.length > one.length - 20);
	assert.equal(findRepetitionLoop(kept), null);
});

test('loop that starts mid-answer and is cut mid-paragraph still keeps one copy', () => {
	const text = 'Önce normal bir açıklama.\n\n' + PARA.repeat(4) + PARA.slice(0, 150);
	const hit = findRepetitionLoop(text);
	assert.ok(hit);
	const kept = text.slice(0, hit.cutAt).trimEnd();
	assert.ok(kept.startsWith('Önce normal bir açıklama.'));
	assert.ok(kept.split('iki yüz karakteri').length - 1 <= 1);
});

test('short-unit CJK loop', () => {
	const text = '答案如下：\n' + '候选者'.repeat(200);
	const hit = findRepetitionLoop(text);
	assert.ok(hit);
	assert.ok(hit.cutAt < 20);
	assert.ok(text.slice(0, hit.cutAt).startsWith('答案如下'));
});

test('normal markdown with many repeated short headings is not a loop', () => {
	let text = '';
	for (let i = 0; i < 40; i++) {
		text += `- **Özellikler:**\n  - madde ${i} için farklı bir açıklama metni ve sayı ${i * 7}\n- **Kullanım:**\n  - kullanım ${i} ayrıntısı\n`;
	}
	assert.equal(findRepetitionLoop(text), null);
});

test('three sections starting with the same 220-char sentence cut at the last occurrence', () => {
	const sentence = ('Aynı uzun giriş cümlesi her bölümün başında geçiyor ve ' + 'x'.repeat(3)).padEnd(219, ' kelime') + '.';
	assert.equal(sentence.length, 220);
	const text = `${sentence} Birinci bölüm farklı devam eder.\n\n${sentence} İkinci bölüm başka bir şey söyler.\n\n${sentence}`;
	const hit = findRepetitionLoop(text);
	assert.ok(hit);
	const lastStart = text.length - 200;
	assert.ok(hit.cutAt <= lastStart);
	assert.ok(lastStart - hit.cutAt < 40);
	const kept = text.slice(0, hit.cutAt).trimEnd();
	assert.ok(kept.includes('İkinci bölüm başka bir şey söyler.'));
});

test('text shorter than tail is null', () => {
	assert.equal(findRepetitionLoop('abc'.repeat(50)), null);
});

test('whitespace-only tail is null', () => {
	assert.equal(findRepetitionLoop('Merhaba dünya.' + ' \n'.repeat(300)), null);
});

test('stray think: at start', () => {
	assert.equal(findStrayThinkClose('</think>\n\nCevap'), 0);
});

test('stray think: mid-text after a newline', () => {
	const text = 'akıl yürütme metni\n</think>\n\nGerçek cevap';
	const idx = findStrayThinkClose(text);
	assert.equal(idx, text.indexOf('</think>'));
	assert.equal(text.slice(0, idx).trim(), 'akıl yürütme metni');
});

test('stray think: indented tag counts', () => {
	const text = 'x\n  \t</think>\nCevap';
	assert.equal(findStrayThinkClose(text), text.indexOf('</think>'));
});

test('stray think: inline mention is ignored', () => {
	assert.equal(findStrayThinkClose('Modeller </think> etiketi kullanır.'), -1);
	assert.equal(findStrayThinkClose('düz metin'), -1);
});

test('stray think: preceded by an opener is not stray', () => {
	assert.equal(findStrayThinkClose('<think>düşünce\n</think>\nCevap'), -1);
});

test('closeOpenFence closes a fence left open by a cut', () => {
	const fence = '`'.repeat(3);
	const open = `Örnek:\n${fence}js\nconst a = 1;`;
	assert.equal(closeOpenFence(open), `${open}\n${fence}`);
	const closed = `a\n${fence}js\nx\n${fence}\nb`;
	assert.equal(closeOpenFence(closed), closed);
	assert.equal(closeOpenFence('düz metin'), 'düz metin');
});
