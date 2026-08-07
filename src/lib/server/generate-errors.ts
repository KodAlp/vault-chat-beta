/**
 * Thrown by every generate-*.ts when retrieve() comes back with zero chunks
 * — carries `narrowScope` so callers can distinguish "nothing relevant in
 * the vault at all" from "relevant chunks exist but a scope filter excluded
 * every one of them" (RetrieveResult.narrowScope, see retrieve.ts). Those
 * two cases call for different user guidance: a flat "kaynak yok" versus a
 * "kapsamı genişlet?" suggestion, same distinction chat's own narrowScope
 * handling already makes (see Message.svelte).
 */
export class NoSourcesError extends Error {
	narrowScope: boolean;

	constructor(narrowScope: boolean) {
		super(
			narrowScope
				? 'Seçili kapsamda kaynak bulunamadı — kapsamı genişletmeyi deneyin.'
				: 'Bu kapsamda kütüphanede yeterli kaynak yok.'
		);
		this.name = 'NoSourcesError';
		this.narrowScope = narrowScope;
	}
}
