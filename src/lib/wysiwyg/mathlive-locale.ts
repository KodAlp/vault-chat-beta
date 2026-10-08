/**
 * MathLive localization (pure data + mapping; the heavy `mathlive` package is
 * only imported by loadMathlive(), on first use of the formula popover).
 *
 * MathLive 0.111 ships ar, de, el, es, fr, he, it, ja, ko, pl, pt, uk, zh-cn
 * and zh-tw besides English, but NOT Turkish, so Turkish is registered here.
 * Only user-visible labels are translated; the `*-template` keys are LaTeX and
 * stay English (a locale table falls back to English for keys it lacks).
 */

export const TR_STRINGS: Record<string, string> = {
	'keyboard.tooltip.symbols': 'Simgeler',
	'keyboard.tooltip.greek': 'Yunan Harfleri',
	'keyboard.tooltip.numeric': 'Sayılar',
	'keyboard.tooltip.alphabetic': 'Latin Harfleri',
	'tooltip.copy to clipboard': 'Panoya Kopyala',
	'tooltip.cut to clipboard': 'Panoya Kes',
	'tooltip.paste from clipboard': 'Panodan Yapıştır',
	'tooltip.redo': 'Yinele',
	'tooltip.toggle virtual keyboard': 'Sanal Klavyeyi Aç/Kapat',
	'tooltip.menu': 'Menü',
	'tooltip.undo': 'Geri Al',
	'menu.borders': 'Kenarlıklar',
	'menu.insert matrix': 'Matris Ekle',
	'menu.array.add row above': 'Üste Satır Ekle',
	'menu.array.add row below': 'Alta Satır Ekle',
	'menu.array.add column after': 'Sağa Sütun Ekle',
	'menu.array.add column before': 'Sola Sütun Ekle',
	'menu.array.delete row': 'Satırı Sil',
	'menu.array.delete rows': 'Seçili Satırları Sil',
	'menu.array.delete column': 'Sütunu Sil',
	'menu.array.delete columns': 'Seçili Sütunları Sil',
	'menu.mode': 'Mod',
	'menu.mode-math': 'Matematik',
	'menu.mode-text': 'Metin',
	'menu.mode-latex': 'LaTeX',
	'menu.insert': 'Ekle',
	'menu.insert.abs': 'Mutlak Değer',
	'menu.insert.nth-root': 'n. Dereceden Kök',
	'menu.insert.log-base': 'a Tabanında Logaritma',
	'menu.insert.heading-calculus': 'Analiz',
	'menu.insert.derivative': 'Türev',
	'menu.insert.nth-derivative': 'n. Türev',
	'menu.insert.integral': 'İntegral',
	'menu.insert.sum': 'Toplam',
	'menu.insert.product': 'Çarpım',
	'menu.insert.heading-complex-numbers': 'Karmaşık Sayılar',
	'menu.insert.modulus': 'Mutlak Değer (Modül)',
	'menu.insert.argument': 'Argüman',
	'menu.insert.real-part': 'Gerçel Kısım',
	'menu.insert.imaginary-part': 'Sanal Kısım',
	'menu.insert.conjugate': 'Eşlenik',
	'tooltip.blackboard': 'Çift Çizgili',
	'tooltip.bold': 'Kalın',
	'tooltip.italic': 'İtalik',
	'tooltip.fraktur': 'Fraktur',
	'tooltip.script': 'El Yazısı',
	'tooltip.caligraphic': 'Hat Yazısı',
	'tooltip.typewriter': 'Daktilo',
	'tooltip.roman-upright': 'Dik Latin',
	'menu.font-style': 'Yazı Stili',
	'menu.accent': 'Vurgu',
	'menu.decoration': 'Süs',
	'menu.color': 'Renk',
	'menu.background-color': 'Arka Plan',
	'menu.cut': 'Kes',
	'menu.copy': 'Kopyala',
	'menu.copy-as-latex': 'LaTeX Olarak Kopyala',
	'menu.copy-as-typst': 'Typst Olarak Kopyala',
	'menu.copy-as-ascii-math': 'ASCII Matematik Olarak Kopyala',
	'menu.copy-as-mathml': 'MathML Olarak Kopyala',
	'menu.paste': 'Yapıştır',
	'menu.select-all': 'Tümünü Seç',
	'color.red': 'Kırmızı',
	'color.orange': 'Turuncu',
	'color.yellow': 'Sarı',
	'color.lime': 'Limon Yeşili',
	'color.green': 'Yeşil',
	'color.teal': 'Deniz Mavisi',
	'color.cyan': 'Camgöbeği',
	'color.blue': 'Mavi',
	'color.indigo': 'Çivit Mavisi',
	'color.purple': 'Mor',
	'color.magenta': 'Eflatun',
	'color.black': 'Siyah',
	'color.dark-grey': 'Koyu Gri',
	'color.grey': 'Gri',
	'color.light-grey': 'Açık Gri',
	'color.white': 'Beyaz'
};

const BUILT_IN = new Set(['en', 'ar', 'de', 'el', 'es', 'fr', 'he', 'it', 'ja', 'ko', 'pl', 'pt', 'uk', 'zh-cn', 'zh-tw']);

/** Map an app locale code ("tr", "zh-CN", "pt", "ar-EG", ...) to a MathLive locale. */
export function mathliveLocale(appLocale: string): string {
	const code = appLocale.toLowerCase();
	if (code === 'tr' || BUILT_IN.has(code)) return code;
	const base = code.split('-')[0];
	if (base === 'tr' || BUILT_IN.has(base)) return base;
	return 'en';
}

/** URL under which static/mathlive-fonts is served (KaTeX fonts MathLive needs). */
export const MATHLIVE_FONTS_DIR = '/mathlive-fonts';

let ready: Promise<typeof import('mathlive')> | null = null;

/** Load MathLive once and configure it for this app (no sounds, served fonts, locale). */
export function loadMathlive(appLocale: string): Promise<typeof import('mathlive')> {
	ready ??= import('mathlive').then((ml) => {
		ml.MathfieldElement.fontsDirectory = MATHLIVE_FONTS_DIR;
		ml.MathfieldElement.soundsDirectory = null;
		ml.MathfieldElement.strings = { tr: TR_STRINGS };
		return ml;
	});
	return ready.then((ml) => {
		ml.MathfieldElement.locale = mathliveLocale(appLocale);
		return ml;
	});
}
