import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appSignals, chunkSupportsApplication } from './chunk-signals';

test('a part with inline math to work with supports application', () => {
	assert.equal(chunkSupportsApplication('Türev: $f(x)=x^2$ için $f\'(x)=2x$ olur.'), true);
	assert.equal(chunkSupportsApplication('Block form:\n$$\\int_0^1 x\\,dx = 1/2$$\nand $$a+b$$'), true);
});

test('one stray dollar amount or a single formula is not enough', () => {
	assert.equal(chunkSupportsApplication('The fee is $5 per month.'), false);
	assert.equal(chunkSupportsApplication('Only one formula here: $E=mc^2$ and nothing to compute.'), false);
});

test('a code fence or indented code supports application', () => {
	assert.equal(chunkSupportsApplication('Example:\n```c\nint a = 3;\n```\n'), true);
	assert.equal(chunkSupportsApplication('Example:\n\n    int sum = 0;\n    for (i = 0; i < n; i++) sum += a[i];\n    return sum;\n'), true, 'three top-level indented lines');
	assert.equal(chunkSupportsApplication('Example:\n\n    for (i = 0; i < n; i++)\n        sum += a[i];\n'), false, 'two lines, one nested deeper, is under the threshold (known limit)');
});

test('numeric expressions and numbered steps count; prose does not', () => {
	assert.equal(chunkSupportsApplication('Then 3 + 4 = 7 and 2 * 5 = 10.'), true);
	assert.equal(chunkSupportsApplication('Steps:\n1. Sort the edges\n2. Pick the smallest\n3. Skip cycles\n'), true);
	assert.equal(chunkSupportsApplication('A process group is a collection of related processes that the terminal controls together.'), false);
	assert.equal(chunkSupportsApplication('İşletim sistemleri süreç zamanlaması için birçok politika kullanır ve bunların hedefleri farklıdır.'), false);
});

test('two numbered lines are a list, not a procedure', () => {
	assert.equal(chunkSupportsApplication('Two items:\n1. first\n2. second\n'), false);
	assert.equal(appSignals('1. a\n2. b\n').steps, 2);
});

test('empty text supports nothing', () => {
	assert.equal(chunkSupportsApplication(''), false);
});
