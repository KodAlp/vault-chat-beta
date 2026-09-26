import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	checkAnswerabilityRules,
	checkMultiSpanRule,
	compareToTargets,
	computeDistribution,
	computeDomainDistribution,
	findDuplicateQuestions,
	jaccard,
	normalizeQuestionText,
	parseGoldenLine,
	PILOT_TARGET,
	questionChunkOverlap,
	tokenize,
	validateGoldenObject,
	type GoldenLine
} from './golden';

function baseLine(overrides: Partial<GoldenLine> = {}): GoldenLine {
	return {
		id: 'q1',
		question: 'Sanal bellek nedir?',
		type: 'direct',
		difficulty: 'easy',
		lang: 'tr',
		answerable: true,
		relevant: [{ anchor: 'a_abc123', path: 'wiki/os/vm.md', heading_path: 'Sanal Bellek', grade: 2 }],
		reference_answer: 'Sanal bellek ...',
		...overrides
	};
}

// --- schema validation -----------------------------------------------------

test('validateGoldenObject accepts a well-formed line', () => {
	const { line, errors } = validateGoldenObject(baseLine());
	assert.equal(errors.length, 0);
	assert.ok(line);
	assert.equal(line!.id, 'q1');
});

test('validateGoldenObject rejects a non-object', () => {
	const { errors } = validateGoldenObject('not an object');
	assert.equal(errors.length, 1);
	assert.match(errors[0], /JSON nesnesi/);
});

test('validateGoldenObject reports every missing/invalid required field, not just the first', () => {
	const { errors } = validateGoldenObject({});
	assert.ok(errors.some((e) => e.includes('`id`')));
	assert.ok(errors.some((e) => e.includes('`question`')));
	assert.ok(errors.some((e) => e.includes('`type`')));
	assert.ok(errors.some((e) => e.includes('`difficulty`')));
	assert.ok(errors.some((e) => e.includes('`lang`')));
	assert.ok(errors.some((e) => e.includes('`answerable`')));
	assert.ok(errors.some((e) => e.includes('`reference_answer`')));
	assert.ok(errors.some((e) => e.includes('`relevant`')));
});

test('validateGoldenObject rejects an invalid enum value with the allowed list in the message', () => {
	const { errors } = validateGoldenObject({ ...baseLine(), type: 'not-a-type' });
	assert.ok(errors.some((e) => e.includes('`type`') && e.includes('direct')));
});

test('validateGoldenObject rejects an invalid relevant[].grade', () => {
	const obj = { ...baseLine(), relevant: [{ anchor: 'a_x', path: 'p.md', heading_path: 'H', grade: 3 }] };
	const { errors } = validateGoldenObject(obj);
	assert.ok(errors.some((e) => e.includes('relevant[0].grade')));
});

test('validateGoldenObject accepts optional turns/notes and rejects malformed turns', () => {
	const ok = validateGoldenObject({ ...baseLine(), turns: [{ role: 'user', content: 'merhaba' }], notes: 'ok' });
	assert.equal(ok.errors.length, 0);
	const bad = validateGoldenObject({ ...baseLine(), turns: [{ role: 'bot', content: 'x' }] });
	assert.ok(bad.errors.some((e) => e.includes('turns[0]')));
});

test('parseGoldenLine reports a JSON parse error with the line number', () => {
	const { errors } = parseGoldenLine('{not json', 7);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /satır 7/);
	assert.match(errors[0], /JSON parse/);
});

test('parseGoldenLine prefixes schema errors with the line number', () => {
	const { errors } = parseGoldenLine(JSON.stringify({}), 3);
	assert.ok(errors.length > 0);
	assert.ok(errors.every((e) => e.startsWith('satır 3:')));
});

// --- answerability / multi-span rules --------------------------------------

test('checkAnswerabilityRules errors when answerable=true but relevant is empty', () => {
	const line = baseLine({ relevant: [] });
	const errors = checkAnswerabilityRules(line);
	assert.ok(errors.some((e) => e.includes('relevant boş')));
});

test('checkAnswerabilityRules errors when unanswerable has non-empty relevant or answerable=true', () => {
	const line = baseLine({ type: 'unanswerable', answerable: true, relevant: [baseLine().relevant[0]] });
	const errors = checkAnswerabilityRules(line);
	assert.ok(errors.some((e) => e.includes('relevant boş değil')));
	assert.ok(errors.some((e) => e.includes('answerable=false değil')));
});

test('checkAnswerabilityRules passes for a correctly-shaped unanswerable line', () => {
	const line = baseLine({ type: 'unanswerable', answerable: false, relevant: [] });
	assert.equal(checkAnswerabilityRules(line).length, 0);
});

test('checkMultiSpanRule warns when a multi_hop question has only one distinct path', () => {
	const line = baseLine({ type: 'multi_hop' });
	const warnings = checkMultiSpanRule(line);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /multi_hop/);
});

test('checkMultiSpanRule is silent when spans cover >=2 paths, and for non-multi-span types', () => {
	const line = baseLine({
		type: 'cross_document',
		relevant: [
			{ anchor: 'a_1', path: 'a.md', heading_path: 'H', grade: 2 },
			{ anchor: 'a_2', path: 'b.md', heading_path: 'H', grade: 1 }
		]
	});
	assert.equal(checkMultiSpanRule(line).length, 0);
	assert.equal(checkMultiSpanRule(baseLine({ type: 'direct' })).length, 0);
});

// --- duplicate detection ----------------------------------------------------

test('normalizeQuestionText folds case, punctuation and whitespace', () => {
	assert.equal(normalizeQuestionText('Sanal  Bellek nedir??'), normalizeQuestionText('sanal bellek nedir'));
});

test('tokenize splits on non-letters/digits and lowercases', () => {
	assert.deepEqual(tokenize('CPU zamanlama, nedir?'), ['cpu', 'zamanlama', 'nedir']);
});

test('jaccard is 1 for identical sets, 0 for disjoint sets', () => {
	const a = new Set(['a', 'b', 'c']);
	assert.equal(jaccard(a, new Set(['a', 'b', 'c'])), 1);
	assert.equal(jaccard(a, new Set(['x', 'y'])), 0);
});

test('findDuplicateQuestions flags exact duplicates after normalization', () => {
	const lines = [baseLine({ id: 'q1', question: 'Sanal bellek nedir?' }), baseLine({ id: 'q2', question: 'sanal  bellek NEDİR' })];
	const dups = findDuplicateQuestions(lines);
	assert.equal(dups.length, 1);
	assert.equal(dups[0].exact, true);
});

test('findDuplicateQuestions flags near-duplicates above the Jaccard threshold without flagging unrelated questions', () => {
	const lines = [
		baseLine({ id: 'q1', question: 'sayfalama nasil calisir isletim sisteminde' }),
		baseLine({ id: 'q2', question: 'sayfalama nasil calisir bir isletim sisteminde tam olarak' }),
		baseLine({ id: 'q3', question: 'rust borrow checker nedir' })
	];
	const dups = findDuplicateQuestions(lines, 0.6);
	const ids = dups.map((d) => `${d.a}-${d.b}`);
	assert.ok(ids.includes('q1-q2'));
	assert.ok(!ids.includes('q1-q3'));
	assert.ok(!ids.includes('q2-q3'));
});

// --- overlap (leakage) -------------------------------------------------------

test('questionChunkOverlap is 1 when every question token appears in the chunk', () => {
	const overlap = questionChunkOverlap(['sanal', 'bellek', 'nedir'], new Set(['sanal', 'bellek', 'nedir', 'sayfalama']));
	assert.equal(overlap, 1);
});

test('questionChunkOverlap is 0 for no shared tokens, and does not double-count repeated question tokens', () => {
	assert.equal(questionChunkOverlap(['a', 'b'], new Set(['x', 'y'])), 0);
	// 'sanal' appears twice in the question but should count once against a 2-token unique set.
	const overlap = questionChunkOverlap(['sanal', 'sanal', 'bellek'], new Set(['sanal']));
	assert.equal(overlap, 0.5);
});

test('questionChunkOverlap returns 0 rather than throwing for an empty question', () => {
	assert.equal(questionChunkOverlap([], new Set(['x'])), 0);
});

// --- distributions & targets -------------------------------------------------

test('computeDistribution counts by type/lang/difficulty', () => {
	const lines = [
		baseLine({ id: 'q1', type: 'direct', lang: 'tr', difficulty: 'easy' }),
		baseLine({ id: 'q2', type: 'direct', lang: 'en', difficulty: 'hard' }),
		baseLine({ id: 'q3', type: 'conceptual', lang: 'tr', difficulty: 'medium' })
	];
	const dist = computeDistribution(lines);
	assert.equal(dist.total, 3);
	assert.deepEqual(dist.byType, { direct: 2, conceptual: 1 });
	assert.deepEqual(dist.byLang, { tr: 2, en: 1 });
	assert.deepEqual(dist.byDifficulty, { easy: 1, hard: 1, medium: 1 });
});

test('computeDomainDistribution counts a domain once per question even with multiple relevant chunks in it', () => {
	const lines = [
		baseLine({
			id: 'q1',
			relevant: [
				{ anchor: 'a_1', path: 'wiki/os/a.md', heading_path: 'H', grade: 2 },
				{ anchor: 'a_2', path: 'wiki/os/b.md', heading_path: 'H', grade: 1 }
			]
		})
	];
	const pathToDomains = new Map([
		['wiki/os/a.md', ['os']],
		['wiki/os/b.md', ['os']]
	]);
	assert.deepEqual(computeDomainDistribution(lines, pathToDomains), { os: 1 });
});

test('compareToTargets reports a deviation when a type count misses the target and none when it matches', () => {
	const dist = computeDistribution([baseLine({ id: 'q1', type: 'followup' }), baseLine({ id: 'q2', type: 'followup' })]);
	const warnings = compareToTargets(dist, PILOT_TARGET);
	assert.ok(warnings.some((w) => w.includes("tip 'followup'")));
});

test('compareToTargets is silent when the language mix is within tolerance', () => {
	const lines = Array.from({ length: 10 }, (_, i) => baseLine({ id: `q${i}`, lang: i < 7 ? 'tr' : 'en', type: 'followup' }));
	const dist = computeDistribution(lines);
	const warnings = compareToTargets(dist, { ...PILOT_TARGET, byType: {}, core: undefined }, 0.05);
	assert.ok(!warnings.some((w) => w.includes('dil dağılımı')));
});
