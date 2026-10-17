import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hideMarkerComments } from './markdown-prepare';

test('hideMarkerComments drops marker-only lines, keeps inline and fenced ones', () => {
	const md = [
		'![a](x.png)',
		'<!-- vc:formul-gorsel abc s.3 k=1,2,3,4 -->',
		'',
		'> ⚠ Formül okunamadı — s. 3',
		'',
		'<!-- vc:formul-latex QUJD -->',
		'text <!-- vc:inline --> kept',
		'```',
		'<!-- vc:incode -->',
		'```',
		''
	].join('\n');
	const out = hideMarkerComments(md);
	assert.ok(!out.includes('vc:formul'));
	assert.ok(out.includes('<!-- vc:inline -->'));
	assert.ok(out.includes('<!-- vc:incode -->'));
	assert.ok(out.includes('> ⚠ Formül okunamadı — s. 3'));
});

test('hideMarkerComments keeps CRLF and leaves text without markers untouched', () => {
	assert.equal(hideMarkerComments('a\r\n<!-- vc:gorsel x -->\r\nb'), 'a\r\nb');
	assert.equal(hideMarkerComments('a <!-- other --> b'), 'a <!-- other --> b');
});
