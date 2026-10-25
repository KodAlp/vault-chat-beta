/**
 * Thrown by every generate-*.ts when retrieve() comes back with zero chunks
 * — carries `narrowScope` so callers can distinguish "nothing relevant in
 * the vault at all" from "relevant chunks exist but a scope filter excluded
 * every one of them" (RetrieveResult.narrowScope, see retrieve.ts). Those
 * two cases call for different user guidance: a flat "kaynak yok" versus a
 * "kapsamı genişlet?" suggestion, same distinction chat's own narrowScope
 * handling already makes (see Message.svelte).
 */
import type { RetrieveResult } from '#lib/types.js';
import { AppError } from './app-error';

/**
 * Every generate-*.ts calls this right after retrieve(), before
 * its own `chunks.length === 0` / NoSourcesError check: retrieve() now runs
 * the FTS keyword fallback whenever embeddingIssue is set, REGARDLESS of
 * whether the caller asked for it (see retrieve.ts's wantsFallback), which
 * means `retrieved.chunks` can be non-empty here even though vector search
 * never ran.
 *
 * Two kinds of "vector search did not run", treated differently on purpose:
 *  - 'mismatch' / 'unavailable' are UNEXPECTED failures (the index and config
 *    disagree, or the provider is down). The generators must not quietly
 *    degrade to un-vetted keyword hits, so this fails loudly with a coded
 *    error instead of falling through to the normal chunks.length===0 check
 *    (which a non-empty keyword result would skip past).
 *  - 'fts-only' is a DELIBERATE configuration: the user chose to
 *    run without an embedding provider, so keyword hits are the only
 *    retrieval there is. The generators proceed with them (and still raise
 *    NoSourcesError when the keyword search finds nothing).
 */
export function assertNoEmbeddingIssue(result: RetrieveResult): void {
	if (result.embeddingIssue === 'mismatch') throw new AppError('EMBEDDING_MISMATCH');
	if (result.embeddingIssue === 'unavailable') throw new AppError('EMBEDDING_UNAVAILABLE');
}

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
