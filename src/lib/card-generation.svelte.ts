import type { CardGenerationEvent, CardGenerationRequest } from './types';
import type { DistributiveOmit } from './distributive-omit';
import { runGenerationStream } from './generation-stream';
import { readResponseError, localizeError } from './server-error';

export type CardGenerationStatus =
	| { id: string; vaultId?: string; phase: 'generating'; stage: string; elapsedMs?: number }
	| { id: string; vaultId?: string; phase: 'done'; deckId: string }
	| { id: string; vaultId?: string; phase: 'error'; message: string; narrowScope?: boolean; embeddingMismatch?: boolean };

/**
 * Module-level $state, not component-local — same reasoning as
 * quiz-generation.svelte.ts: generation must survive the dialog that
 * started it closing (and the user navigating away) rather than blocking
 * the screen for the 20s-2min a real generation takes.
 *
 * An array, not a single `status` slot (Faz 13) — see
 * quiz-generation.svelte.ts's doc comment for why: a second generation
 * starting used to silently overwrite the first one's still-unread "done"
 * status. Each entry carries its own client-generated `id`.
 *
 * Boxed in a const object on purpose: Svelte 5 forbids exporting a `let`
 * $state binding that gets reassigned. Consumers read
 * `cardGeneration.items`, never reassign `cardGeneration` itself.
 */
export const cardGeneration = $state<{ items: CardGenerationStatus[] }>({
	items: []
});

/** One AbortController per in-flight generation, keyed by the same
 * client-generated id as its items entry — see quiz-generation.svelte.ts's
 * identical comment. */
const controllers = new Map<string, AbortController>();

export async function startCardGeneration(body: CardGenerationRequest): Promise<void> {
	const id = crypto.randomUUID();

	// See quiz-generation.svelte.ts's identical comment — drops a stale
	// error/done entry for this vault so a retry doesn't stack a new
	// "generating" toast on top of the old error toast.
	cardGeneration.items = cardGeneration.items.filter(
		(s) => s.phase === 'generating' || s.vaultId !== body.vault
	);

	function setStatus(status: DistributiveOmit<CardGenerationStatus, 'id' | 'vaultId'>) {
		const next = { id, vaultId: body.vault, ...status } as CardGenerationStatus;
		const idx = cardGeneration.items.findIndex((s) => s.id === id);
		if (idx === -1) cardGeneration.items.push(next);
		else cardGeneration.items[idx] = next;
	}

	setStatus({ phase: 'generating', stage: 'retrieving' });

	const controller = new AbortController();
	controllers.set(id, controller);

	const result = await runGenerationStream<CardGenerationEvent>(
		'/api/generate/cards',
		body,
		controller,
		(event) => {
			if (event.type === 'progress') {
				setStatus({ phase: 'generating', stage: event.stage, elapsedMs: event.elapsedMs });
			} else if (event.type === 'done') {
				setStatus({ phase: 'done', deckId: event.deckId });
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
	// 'cancelled': cancelCardGeneration() already removed the entry — a
	// user-initiated cancel must never surface as an error. 'ok': the
	// stream's own terminal 'done'/'error' event already set the final
	// status above.
}

export function dismissCardGeneration(id: string): void {
	const idx = cardGeneration.items.findIndex((s) => s.id === id);
	if (idx !== -1) cardGeneration.items.splice(idx, 1);
}

/** Cancels an in-flight generation: aborts its fetch/stream and removes its
 * toast immediately, rather than waiting for the stream loop to unwind and
 * report back — a user-initiated cancel must never be shown as an error. */
export function cancelCardGeneration(id: string): void {
	controllers.get(id)?.abort();
	controllers.delete(id);
	dismissCardGeneration(id);
}
