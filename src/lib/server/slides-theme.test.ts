import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Theme } from '@marp-team/marpit';
import { SLIDES_THEME_NAME, SLIDES_THEME_CSS } from './slides-theme';
import { SLIDE_LAYOUTS } from './slides-schema';

test('the theme CSS declares @theme with the exported name and parses via the real Marpit theme parser', () => {
	const theme = Theme.fromCSS(SLIDES_THEME_CSS);
	assert.equal(theme.name, SLIDES_THEME_NAME);
});

test('the theme declares a 16:9 size', () => {
	const theme = Theme.fromCSS(SLIDES_THEME_CSS);
	assert.equal(theme.widthPixel, 1280);
	assert.equal(theme.heightPixel, 720);
});

// Every layout the schema can produce needs its own selector here — an
// enum value with no matching CSS renders identically to plain `bullets`,
// silently defeating the whole point (layout çeşitliliği).
test('every SLIDE_LAYOUTS value has a matching .{layout} selector in the theme CSS', () => {
	for (const layout of SLIDE_LAYOUTS) {
		if (layout === 'bullets') continue; // the unstyled default — base `section` rules cover it on purpose
		assert.match(SLIDES_THEME_CSS, new RegExp(`\\.${layout}\\b`), `no CSS selector found for layout "${layout}"`);
	}
});
