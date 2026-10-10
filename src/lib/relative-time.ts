import { intlLocale } from './i18n/locales';

/** Locale-aware "2 hours ago"/"2 saat önce" formatting shared by any
 * component that shows a timestamp relative to now. `locale` should be
 * i18n.locale (every Locale code is a BCP-47 tag: zh-CN, ar-EG, ...), not a
 * hardcoded value, so this reflects the UI language setting rather than
 * staying stuck in one language. intlLocale() degrades codes the engine's ICU
 * doesn't know (a minority language in older WebViews) to en instead of the OS default. */
export function relativeTime(iso: string, locale: string): string {
	let rtf: Intl.RelativeTimeFormat;
	try {
		rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' });
	} catch {
		rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
	}
	const diffMin = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
	if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
	const diffHour = Math.round(diffMin / 60);
	if (Math.abs(diffHour) < 24) return rtf.format(diffHour, 'hour');
	const diffDay = Math.round(diffHour / 24);
	return rtf.format(diffDay, 'day');
}
