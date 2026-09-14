/**
 * Thrown by every generate-*.ts when retrieve() comes back with zero chunks
 * — carries `narrowScope` so callers can distinguish "nothing relevant in
 * the vault at all" from "relevant chunks exist but a scope filter excluded
 * every one of them" (RetrieveResult.narrowScope, see retrieve.ts). Those
 * two cases call for different user guidance: a flat "kaynak yok" versus a
 * "kapsamı genişlet?" suggestion, same distinction chat's own narrowScope
 * handling already makes (see Message.svelte).
 */
import type { RetrieveResult } from '$lib/types';

export class NoSourcesError extends Error {
	narrowScope: boolean;
	/** Which of retrieve()'s empty-return paths produced this — see
	 * RetrieveResult.reason. Carried through purely for app-log.ts's
	 * no_sources record; the user-facing message above never changes. */
	reason?: RetrieveResult['reason'];

	constructor(narrowScope: boolean, reason?: RetrieveResult['reason']) {
		super(
			narrowScope
				? 'Seçili kapsamda kaynak bulunamadı — kapsamı genişletmeyi deneyin.'
				: 'Bu kapsamda kütüphanede yeterli kaynak yok.'
		);
		this.name = 'NoSourcesError';
		this.narrowScope = narrowScope;
		this.reason = reason;
	}
}
