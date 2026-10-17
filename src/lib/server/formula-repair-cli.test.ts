import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRepairOutput } from './formula-repair-cli';
import { AppError } from './app-error';

test('ok line: candidates are normalized, deduplicated and unsafe ones dropped', () => {
	const line = JSON.stringify({
		ok: true,
		page: 7,
		bbox: [1, 2, 3, 4],
		bbox_source: 'match',
		candidates: [
			{ latex: ' x^2 ', source: 'mineru:stock', katex_ok: true },
			{ latex: 'x^2', source: 'mineru:tight', katex_ok: true },
			{ latex: 'a $$ b', source: 'mineru:stored', katex_ok: true },
			{ latex: '\\frac{', source: 'previous', katex_ok: false },
			{ latex: 'y', source: 'mineru:stored' }
		]
	});
	const r = parseRepairOutput(`noise\n${line}\n`);
	assert.equal(r.page, 7);
	assert.deepEqual(r.bbox, [1, 2, 3, 4]);
	assert.equal(r.bboxSource, 'match');
	assert.deepEqual(r.candidates.map((c) => [c.latex, c.katexOk]), [['x^2', true], ['\\frac{', false], ['y', null]]);
});

test('fail codes map to AppError codes', () => {
	const code = (c: string) => {
		try {
			parseRepairOutput(JSON.stringify({ ok: false, code: c, detail: 'd' }));
		} catch (e) {
			return (e as AppError).code;
		}
	};
	assert.equal(code('NO_CUDA'), 'FORMULA_REPAIR_NO_CUDA');
	assert.equal(code('PDF_OPEN_FAILED'), 'PDF_DAMAGED');
	assert.equal(code('PAGE_OUT_OF_RANGE'), 'FORMULA_REPAIR_BAD_PAGE');
	assert.equal(code('NO_BOX'), 'FORMULA_REPAIR_NO_BOX');
	assert.equal(code('MODEL_MISSING'), 'FORMULA_REPAIR_MODEL_MISSING');
	assert.equal(code('FAILED'), 'FORMULA_REPAIR_FAILED');
});

test('no JSON line is FORMULA_REPAIR_FAILED with the stderr tail', () => {
	assert.throws(
		() => parseRepairOutput('garbage', 'Traceback boom'),
		(e) => e instanceof AppError && e.code === 'FORMULA_REPAIR_FAILED' && String(e.params?.detail).includes('boom')
	);
});
