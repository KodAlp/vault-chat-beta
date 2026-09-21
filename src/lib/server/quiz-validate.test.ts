import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStatement, leaksSourceId, matchOption, validateQuizBatch, type BatchContext } from './quiz-validate';
import { buildQuizItemsJsonSchema } from './quiz-schema';

const chunks = new Map([
	['S1', { path: 'wiki/a/one.md', heading_path: 'One > A' }],
	['S2', { path: 'wiki/a/two.md', heading_path: 'Two > B' }],
	['S3', { path: 'wiki/a/three.md', heading_path: 'Three > C' }]
]);
const ctx = (over: Partial<BatchContext> = {}): BatchContext => ({ idToChunk: chunks, expectedCount: 1, ...over });
const options = ['bir', 'iki', 'üç', 'dört', 'beş'];
const mc = (over: object = {}) => ({ type: 'multiple_choice', question: 'Hangisi?', options, answer: 'üç', explanation: 'e', source_id: 'S1', ...over });
const tf = (over: object = {}) => ({ type: 'true_false', question: 'Dijkstra negatif kenarlarla çalışır', answer: 'false', explanation: 'e', source_id: 'S1', ...over });
const open = (over: object = {}) => ({ type: 'open', question: 'x²’in türevini hesaplayınız.', answer: '2x', explanation: 'e', source_id: 'S1', ...over });
const raw = (...items: object[]) => JSON.stringify({ items });

test('a well-formed multiple-choice item passes and is resolved to its real source', () => {
	const r = validateQuizBatch(raw(mc()), ctx({ kind: 'multiple_choice' }));
	assert.ok(r.ok);
	assert.equal(r.items[0].source_path, 'wiki/a/one.md');
	assert.equal(r.items[0].heading_path, 'One > A');
	assert.equal(r.items[0].sourceId, 'S1');
});

test('multiple choice WITHOUT options is rejected (46 of 80 real ones had none)', () => {
	const r = validateQuizBatch(raw(mc({ options: undefined })), ctx({ kind: 'multiple_choice' }));
	assert.equal(r.ok, false);
	assert.match(!r.ok ? r.error : '', /5 seçenek/);
});

test('multiple choice with duplicate options is rejected', () => {
	const r = validateQuizBatch(raw(mc({ options: ['a', 'A', 'b', 'c', 'd'], answer: 'b' })), ctx());
	assert.equal(r.ok, false);
});

test('the answer must be one of the options; a letter-labelled answer is resolved to the exact option text', () => {
	assert.equal(validateQuizBatch(raw(mc({ answer: 'altı' })), ctx()).ok, false);
	const labelled = validateQuizBatch(raw(mc({ options: ['A) bir', 'B) iki', 'C) üç', 'D) dört', 'E) beş'], answer: 'C) üç' })), ctx());
	assert.ok(labelled.ok && labelled.items[0].answer === 'C) üç');
	const stripped = validateQuizBatch(raw(mc({ options: ['bir', 'iki', 'üç', 'dört', 'beş'], answer: 'C) üç' })), ctx());
	assert.ok(stripped.ok, 'a stray label on the answer only');
	assert.equal(stripped.ok && stripped.items[0].answer, 'üç', 'stored as the option text the page sends back');
});

test('matchOption: exact, label-insensitive, and null when ambiguous or absent', () => {
	assert.equal(matchOption(' üç ', options), 'üç');
	assert.equal(matchOption('B) iki', options), 'iki');
	assert.equal(matchOption('yok', options), null);
	assert.equal(matchOption('A) x', ['A) x', 'B) x', 'c', 'd', 'e']), 'A) x', 'exact wins over loose');
	assert.equal(matchOption('x', ['A) x', 'B) x', 'c', 'd', 'e']), null, 'two loose matches are ambiguous');
});

test('a true/false answer is normalised to lower case (a stored "False" is never equal to the "false" the page sends)', () => {
	const r = validateQuizBatch(raw(tf({ answer: 'False' })), ctx({ kind: 'true_false' }));
	assert.ok(r.ok);
	assert.equal(r.items[0].answer, 'false');
	assert.equal(validateQuizBatch(raw(tf({ answer: 'evet' })), ctx()).ok, false);
});

test('a true/false item must be a statement, not a question', () => {
	assert.equal(isStatement('Dijkstra negatif kenarlarla çalışır'), true);
	assert.equal(isStatement('Dijkstra negatif kenarlarla çalışır mı?'), false);
	assert.equal(isStatement('x = 2 noktasındaki türevi kaçtır?  '), false);
	assert.equal(validateQuizBatch(raw(tf({ question: 'f(x)=x² olduğuna göre f(2) kaçtır?' })), ctx()).ok, false);
});

test('options are dropped from true/false and open items', () => {
	const t = validateQuizBatch(raw(tf({ options })), ctx());
	assert.ok(t.ok && t.items[0].options === undefined);
	const o = validateQuizBatch(raw(open({ options })), ctx());
	assert.ok(o.ok && o.items[0].options === undefined);
});

test('a batch must hold exactly the requested count and only the requested type', () => {
	assert.equal(validateQuizBatch(raw(mc(), mc({ question: 'b' })), ctx({ expectedCount: 1 })).ok, false);
	const mixed = validateQuizBatch(raw(mc(), open({ question: 'b' })), ctx({ expectedCount: 2, kind: 'multiple_choice' }));
	assert.equal(mixed.ok, false);
	assert.match(!mixed.ok ? mixed.error : '', /türü yanlış/);
});

test('source ids outside this batch\'s slice are rejected even if they exist elsewhere in the pool', () => {
	const r = validateQuizBatch(raw(mc({ source_id: 'S3' })), ctx({ allowedIds: ['S1', 'S2'] }));
	assert.equal(r.ok, false);
	assert.equal(validateQuizBatch(raw(mc({ source_id: 'S9' })), ctx()).ok, false);
});

test('each question must cite the source part assigned to its position', () => {
	const two = raw(open({ question: 'a', source_id: 'S1' }), open({ question: 'b', source_id: 'S3' }));
	assert.equal(validateQuizBatch(two, ctx({ expectedCount: 2, slots: ['S1', 'S3'] })).ok, true);
	const swapped = validateQuizBatch(two, ctx({ expectedCount: 2, slots: ['S3', 'S1'] }));
	assert.equal(swapped.ok, false);
	assert.match(!swapped.ok ? swapped.error : '', /1. sorunun source_id/);
	// the same id may legitimately be assigned twice when the pool is smaller than the quiz
	const same = raw(open({ question: 'a', source_id: 'S2' }), open({ question: 'b', source_id: 'S2' }));
	assert.equal(validateQuizBatch(same, ctx({ expectedCount: 2, slots: ['S2', 'S2'] })).ok, true);
});

test('bad JSON and schema violations come back as a retry message, never an exception', () => {
	assert.equal(validateQuizBatch('not json', ctx()).ok, false);
	assert.equal(validateQuizBatch('{"items":[{"type":"open"}]}', ctx()).ok, false);
});

// ---- the grammar that makes the rest enforceable

type ItemSchema = { properties: Record<string, { enum?: string[]; minItems?: number }>; required: readonly string[] };
const item = (kind?: 'multiple_choice' | 'true_false' | 'open'): ItemSchema =>
	(buildQuizItemsJsonSchema(['S1'], 3, kind).properties.items as unknown as { items: ItemSchema }).items;

test('multiple-choice grammar REQUIRES five options; the mixed grammar does not', () => {
	assert.ok(item('multiple_choice').required.includes('options'));
	assert.equal(item('multiple_choice').properties.options.minItems, 5);
	assert.equal(item().required.includes('options'), false);
});

test('true/false grammar pins the answer to true|false and has no options; open has none either', () => {
	assert.deepEqual(item('true_false').properties.answer.enum, ['true', 'false']);
	assert.equal('options' in item('true_false').properties, false);
	assert.equal('options' in item('open').properties, false);
});

test('a typed grammar pins the item type to that one value', () => {
	for (const k of ['multiple_choice', 'true_false', 'open'] as const) assert.deepEqual(item(k).properties.type.enum, [k]);
	assert.equal(item().properties.type.enum!.length, 3);
});

test('the grammar asks for exactly `total` items', () => {
	const s = buildQuizItemsJsonSchema(['S1'], 4, 'open').properties.items as { minItems: number; maxItems: number };
	assert.equal(s.minItems, 4);
	assert.equal(s.maxItems, 4);
});

test('with slots the grammar pins one source id per position (prefixItems) instead of one enum for all', () => {
	const schema = buildQuizItemsJsonSchema(['S1', 'S2', 'S3'], 3, 'open', ['S3', 'S1', 'S2']) as unknown as { properties: { items: { prefixItems: { properties: { source_id: { enum: string[] } } }[]; items?: unknown; minItems: number; maxItems: number } } };
	const it = schema.properties.items;
	assert.equal(it.items, undefined);
	assert.deepEqual(it.prefixItems.map((p) => p.properties.source_id.enum), [['S3'], ['S1'], ['S2']]);
	assert.equal(it.minItems, 3);
	assert.equal(it.maxItems, 3);
});

test('slots of the wrong length fall back to the plain enum grammar rather than a malformed schema', () => {
	const schema = buildQuizItemsJsonSchema(['S1', 'S2'], 3, 'open', ['S1']) as unknown as { properties: { items: { prefixItems?: unknown; items?: { properties: { source_id: { enum: string[] } } } } } };
	assert.equal(schema.properties.items.prefixItems, undefined);
	assert.deepEqual(schema.properties.items.items!.properties.source_id.enum, ['S1', 'S2']);
});

test('a source id written into the question, an option or the explanation is rejected with a retry message', () => {
	for (const bad of [
		open({ question: 'S3 kaynak parçasında verilen tanımı kullanarak $f(x)=x^2$ türevini hesaplayınız.' }),
		open({ question: "S3 id'sindeki kaynakta hangi teorem verilmiştir?" }),
		open({ explanation: 'S2 kaynağına göre sonuç 2x olur.' }),
		mc({ options: ['S1 içindeki tanım', 'iki', 'üç', 'dört', 'beş'], answer: 'üç' })
	]) {
		const r = validateQuizBatch(raw(bad), ctx());
		assert.equal(r.ok, false, JSON.stringify(bad).slice(0, 60));
		assert.match(!r.ok ? r.error : '', /kaynak kimlik/);
	}
});

test('leaksSourceId matches the id as a word only, and only ids of this pool', () => {
	const ids = ['S1', 'S12'];
	assert.equal(leaksSourceId('S1 kaynağına göre', ids), true);
	assert.equal(leaksSourceId('(S12) tanımı', ids), true);
	assert.equal(leaksSourceId('S123 ve S10 sayıları', ids), false, 'S123 / S10 are not S1 or S12');
	assert.equal(leaksSourceId('BS1 protokolü ve S1x', ids), false, 'letters glued to the id are another token');
	assert.equal(leaksSourceId('$S_1$ simetrik grup', ids), false, 'math subscript notation is not an id');
	assert.equal(leaksSourceId('S5 kaynağına göre', ids), false, 'S5 is not in this pool');
	assert.equal(leaksSourceId('Dijkstra algoritması negatif kenarlarla çalışmaz', ids), false);
});

test('ordinary questions with no id still pass', () => {
	assert.ok(validateQuizBatch(raw(open()), ctx()).ok);
	assert.ok(validateQuizBatch(raw(tf()), ctx()).ok);
});
