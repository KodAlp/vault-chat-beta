import { t } from '$lib/i18n/index.svelte';

export interface ScopeCounts {
	selected: number;
	total: number;
	areasSelected: number;
	areasTotal: number;
}

/** Short wording of the current source scope ("Tüm kasa" / "13 / 14 alan" /
 * "Kaynak yok") — shared by the composer chip and the sidebar's Kaynaklar card. */
export function scopeSummary(c: ScopeCounts): string {
	const zero = c.total > 0 && c.selected === 0;
	const partial = c.total > 0 && c.selected > 0 && c.selected < c.total;
	return zero
		? t('SourceTrigger.none')
		: partial
			? t('SourceTrigger.areas', { selected: c.areasSelected, total: c.areasTotal })
			: t('SourceTrigger.all');
}
