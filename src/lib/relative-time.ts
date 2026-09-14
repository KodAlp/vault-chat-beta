/** Locale-aware "2 hours ago"/"2 saat önce" formatting shared by any
 * component that shows a timestamp relative to now. `locale` should be
 * i18n.locale (its two values, 'tr'/'en', are themselves valid BCP-47 tags
 * Intl accepts directly), not a hardcoded value, so this reflects the UI
 * language setting rather than staying stuck in one language. */
export function relativeTime(iso: string, locale: string): string {
	const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
	const diffMin = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
	if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
	const diffHour = Math.round(diffMin / 60);
	if (Math.abs(diffHour) < 24) return rtf.format(diffHour, 'hour');
	const diffDay = Math.round(diffHour / 24);
	return rtf.format(diffDay, 'day');
}
