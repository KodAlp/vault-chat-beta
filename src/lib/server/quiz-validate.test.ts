import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStatement, leaksSourceId, matchOption, replaceSourceIds, sourceLabel, validateQuizBatch, type BatchContext } from './quiz-validate';
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

test('a source id in the question or an option is rejected (nothing sensible to repair it to)', () => {
	for (const bad of [
		open({ question: 'S3 kaynak parçasında verilen tanımı kullanarak $f(x)=x^2$ türevini hesaplayınız.' }),
		open({ question: "S3 id'sindeki kaynakta hangi teorem verilmiştir?" }),
		mc({ options: ['S1 içindeki tanım', 'iki', 'üç', 'dört', 'beş'], answer: 'üç' })
	]) {
		const r = validateQuizBatch(raw(bad), ctx());
		assert.equal(r.ok, false, JSON.stringify(bad).slice(0, 60));
		assert.match(!r.ok ? r.error : '', /kaynak kimlik/);
		assert.equal(!r.ok && r.code, 'id_in_question');
	}
});

test('a source id in the EXPLANATION is replaced by the source\'s name instead of losing the batch', () => {
	// measured: every leak that got a batch rejected sat in the explanation, and the model repeated it on the retry
	const r = validateQuizBatch(raw(open({ explanation: 'S2 kaynağına göre sonuç 2x olur; S1 de aynısını söyler.' })), ctx());
	assert.ok(r.ok);
	assert.equal(r.items[0].explanation, 'Two kaynağına göre sonuç 2x olur; One de aynısını söyler.');
	assert.equal(r.items[0].question, 'x²’in türevini hesaplayınız.', 'the question is untouched');
	assert.equal(replaceSourceIds('Ilgisiz metin S7', { idToChunk: chunks }), 'Ilgisiz metin S7', 'an id that is not in this pool is left alone');
});

test('an id that is the part\'s own content is not a leak (a database note that talks about "Schedule S1")', () => {
	const withText = new Map([
		['S1', { path: 'wiki/db/tx.md', heading_path: 'Transactions > Schedules', display_text: 'Schedule S1 is serializable, schedule S2 is not.' }],
		['S2', { path: 'wiki/db/other.md', heading_path: 'Other > A', display_text: 'nothing about ids' }]
	]);
	const c = ctx({ idToChunk: withText, allowedIds: ['S1', 'S2'] });
	const legit = validateQuizBatch(raw(open({ question: 'Schedule S1 serileştirilebilir mi, hesaplayınız.', explanation: 'S1 serileştirilebilir, S2 değil.' })), c);
	assert.ok(legit.ok, 'S1 and S2 occur in the shown text');
	assert.equal(legit.items[0].explanation, 'S1 serileştirilebilir, S2 değil.', 'and are left as written');
	// an id the shown text never uses is still a leak
	const only = new Map([['S1', { path: 'a.md', heading_path: 'A > x', display_text: 'plain text' }], ['S2', { path: 'b.md', heading_path: 'B > y', display_text: 'plain text' }]]);
	assert.equal(validateQuizBatch(raw(open({ question: 'S2 kaynağında ne yazar?' })), ctx({ idToChunk: only })).ok, false);
});

test('leaksSourceId matches the id as a word only, only ids of this pool, and not what the shown text itself contains', () => {
	const ids = ['S1', 'S12'];
	assert.equal(leaksSourceId('S1 kaynağına göre', ids), true);
	assert.equal(leaksSourceId('(S12) tanımı', ids), true);
	assert.equal(leaksSourceId('S123 ve S10 sayıları', ids), false, 'S123 / S10 are not S1 or S12');
	assert.equal(leaksSourceId('BS1 protokolü ve S1x', ids), false, 'letters glued to the id are another token');
	assert.equal(leaksSourceId('$S_1$ simetrik grup', ids), false, 'math subscript notation is not an id');
	assert.equal(leaksSourceId('S5 kaynağına göre', ids), false, 'S5 is not in this pool');
	assert.equal(leaksSourceId('Dijkstra algoritması negatif kenarlarla çalışmaz', ids), false);
	assert.equal(leaksSourceId('S1 serileştirilebilir', ids, ['the schedule S1 commits']), false, 'S1 is in the shown text');
	assert.equal(leaksSourceId('S12 kaynağı', ids, ['the schedule S1 commits']), true, 'S12 is not');
});

test('sourceLabel is the note title (heading root), or the file name when there is none', () => {
	assert.equal(sourceLabel({ path: 'wiki/db/x.md', heading_path: 'Database System Concepts > Chapter 1 > Intro' }), 'Database System Concepts');
	assert.equal(sourceLabel({ path: 'wiki/db/normal-forms.md', heading_path: '' }), 'normal-forms');
});

test('every failure carries a code the caller can log without parsing Turkish text', () => {
	const code = (r: ReturnType<typeof validateQuizBatch>) => (!r.ok ? r.code : 'ok');
	assert.equal(code(validateQuizBatch('not json', ctx())), 'json');
	assert.equal(code(validateQuizBatch('{"items":[{"type":"open"}]}', ctx())), 'schema');
	assert.equal(code(validateQuizBatch(raw(mc(), mc({ question: 'b' })), ctx({ expectedCount: 1 }))), 'count');
	assert.equal(code(validateQuizBatch(raw(mc({ source_id: 'S9' })), ctx())), 'source_id');
	assert.equal(code(validateQuizBatch(raw(open()), ctx({ kind: 'multiple_choice' }))), 'type');
	assert.equal(code(validateQuizBatch(raw(mc()), ctx({ slots: ['S2'] }))), 'slot');
	assert.equal(code(validateQuizBatch(raw(mc({ options: undefined })), ctx())), 'options_count');
	assert.equal(code(validateQuizBatch(raw(mc({ options: ['a', 'A', 'b', 'c', 'd'], answer: 'b' })), ctx())), 'options_not_distinct');
	assert.equal(code(validateQuizBatch(raw(mc({ answer: 'altı' })), ctx())), 'answer_not_option');
	assert.equal(code(validateQuizBatch(raw(tf({ answer: 'evet' })), ctx())), 'answer_not_bool');
	assert.equal(code(validateQuizBatch(raw(tf({ question: 'kaçtır?' })), ctx())), 'not_statement');
});

test('ordinary questions with no id still pass', () => {
	assert.ok(validateQuizBatch(raw(open()), ctx()).ok);
	assert.ok(validateQuizBatch(raw(tf()), ctx()).ok);
});
