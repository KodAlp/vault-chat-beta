import type { SlidesGenerationEvent, SlidesGenerationRequest } from './types';
import type { DistributiveOmit } from './distributive-omit';
import { runGenerationStream } from './generation-stream';
import { readResponseError, localizeError } from './server-error';

export type SlidesGenerationStatus =
	| { id: string; vaultId?: string; phase: 'generating'; stage: string; elapsedMs?: number }
	| { id: string; vaultId?: string; phase: 'done'; slideDeckId: string }
	| { id: string; vaultId?: string; phase: 'error'; message: string; narrowScope?: boolean; embeddingMismatch?: boolean };

/** Array of entries, not a single `status` slot (Faz 13) — see
 * quiz-generation.svelte.ts's doc comment for the full rationale. */
export const slidesGeneration = $state<{ items: SlidesGenerationStatus[] }>({
	items: []
});

/** One AbortController per in-flight generation, keyed by the same
 * client-generated id as its items entry — see quiz-generation.svelte.ts's
 * identical comment. */
const controllers = new Map<string, AbortController>();

export async function startSlidesGeneration(body: SlidesGenerationRequest): Promise<void> {
	const id = crypto.randomUUID();

	// See quiz-generation.svelte.ts's identical comment — drops a stale
	// error/done entry for this vault so a retry doesn't stack a new
	// "generating" toast on top of the old error toast.
	slidesGeneration.items = slidesGeneration.items.filter(
		(s) => s.phase === 'generating' || s.vaultId !== body.vault
	);

	function setStatus(status: DistributiveOmit<SlidesGenerationStatus, 'id' | 'vaultId'>) {
		const next = { id, vaultId: body.vault, ...status } as SlidesGenerationStatus;
		const idx = slidesGeneration.items.findIndex((s) => s.id === id);
		if (idx === -1) slidesGeneration.items.push(next);
		else slidesGeneration.items[idx] = next;
	}

	setStatus({ phase: 'generating', stage: 'retrieving' });

	const controller = new AbortController();
	controllers.set(id, controller);

	const result = await runGenerationStream<SlidesGenerationEvent>(
		'/api/generate/slides',
		body,
		controller,
		(event) => {
			if (event.type === 'progress') {
				setStatus({ phase: 'generating', stage: event.stage, elapsedMs: event.elapsedMs });
			} else if (event.type === 'done') {
				setStatus({ phase: 'done', slideDeckId: event.slideDeckId });
			} else if (event.type === 'error') {
				setStatus({ phase: 'error', message: localizeError(event), narrowScope: event.narrowScope, embeddingMismatch: event.code === 'EMBEDDING_MISMATCH' });
			}
		}
	);

	controllers.delete(id);

	if (result.kind === 'bad-response') {
		setStatus({ phase: 'error', message: await readResponseError(result.response) });
	} else if (result.kind === 'fetch-error') {
		setStatus({
			phase: 'error',
			message: localizeError({ message: result.err instanceof Error ? result.err.message : undefined })
		});
	} else if (result.kind === 'stalled') {
		setStatus({ phase: 'error', message: localizeError({ code: 'GEN_STALLED' }) });
	} else if (result.kind === 'incomplete') {
		setStatus({ phase: 'error', message: localizeError({ code: 'GEN_STREAM_ENDED' }) });
	}
	// 'cancelled': cancelSlidesGeneration() already removed the entry — a
	// user-initiated cancel must never surface as an error. 'ok': the
	// stream's own terminal 'done'/'error' event already set the final
	// status above.
}

export function dismissSlidesGeneration(id: string): void {
	const idx = slidesGeneration.items.findIndex((s) => s.id === id);
	if (idx !== -1) slidesGeneration.items.splice(idx, 1);
}

/** Cancels an in-flight generation: aborts its fetch/stream and removes its
 * toast immediately, rather than waiting for the stream loop to unwind and
 * report back — a user-initiated cancel must never be shown as an error. */
export function cancelSlidesGeneration(id: string): void {
	controllers.get(id)?.abort();
	controllers.delete(id);
	dismissSlidesGeneration(id);
}
