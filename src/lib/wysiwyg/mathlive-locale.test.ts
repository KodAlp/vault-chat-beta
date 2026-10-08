import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mathliveLocale, TR_STRINGS } from './mathlive-locale';

test('app locales map to MathLive locales', () => {
	assert.equal(mathliveLocale('tr'), 'tr');
	assert.equal(mathliveLocale('en'), 'en');
	assert.equal(mathliveLocale('de'), 'de');
	assert.equal(mathliveLocale('zh-CN'), 'zh-cn');
	assert.equal(mathliveLocale('ar-EG'), 'ar');
	assert.equal(mathliveLocale('pcm'), 'en'); // no MathLive table for Nigerian Pidgin
	assert.equal(mathliveLocale('hi'), 'en');
});

test('Turkish table has only real keys and no empty values', () => {
	for (const [k, v] of Object.entries(TR_STRINGS)) {
		assert.ok(/^(keyboard|tooltip|menu|color)\./.test(k), k);
		assert.ok(v.trim().length > 0, k);
		assert.ok(!k.endsWith('-template'), `${k}: templates are LaTeX and must not be translated`);
	}
	assert.ok(Object.keys(TR_STRINGS).length > 60);
});
