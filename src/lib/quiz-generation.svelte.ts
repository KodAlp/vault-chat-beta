import type { QuizGenerationEvent, QuizGenerationRequest } from './types';
import type { DistributiveOmit } from './distributive-omit';
import { runGenerationStream } from './generation-stream';
import { readResponseError, localizeError } from './server-error';

export type QuizGenerationStatus =
	| { id: string; vaultId?: string; phase: 'generating'; stage: string; elapsedMs?: number }
	| { id: string; vaultId?: string; phase: 'done'; quizId: string; requested?: number; delivered?: number }
	| { id: string; vaultId?: string; phase: 'error'; message: string; narrowScope?: boolean; embeddingMismatch?: boolean };

/**
 * Module-level $state, not component-local — generation must survive the
 * dialog that started it being closed (and the user navigating elsewhere
 * entirely) rather than blocking the screen for the 20s-2min a real
 * generation can take. Any page can render a widget reading this; the
 * fetch loop itself lives here so it isn't tied to any one component's
 * lifetime.
 *
 * An array of entries, not a single `status` slot — the old
 * singleton meant a second generation starting before the first one's
 * "done" toast was dismissed silently overwrote it, erasing the only
 * pointer to that first quiz's id from the UI (it still existed in
 * study.db, just became unreachable without knowing its id already).
 * Each entry carries its own `id`, generated client-side at start; no
 * 'idle' variant exists because an idle generation simply isn't in the
 * array.
 *
 * Boxed in a const object on purpose: Svelte 5 forbids exporting a `let`
 * $state binding that gets reassigned (compiler error state_invalid_export)
 * — only mutating a property of an exported const is allowed. Consumers
 * read `quizGeneration.items`, never reassign `quizGeneration` itself.
 */
export const quizGeneration = $state<{ items: QuizGenerationStatus[] }>({
	items: []
});

/** One AbortController per in-flight generation, keyed by the same
 * client-generated id as its items entry — lets cancelQuizGeneration(id)
 * stop the fetch/stream without generation-stream.ts needing to know
 * anything about this store's id scheme. */
const controllers = new Map<string, AbortController>();

export async function startQuizGeneration(body: QuizGenerationRequest): Promise<void> {
	const id = crypto.randomUUID();

	// A stale error/done entry for this same vault must not stick around
	// once a new generation starts — retrying after a failure used to leave
	// the old error toast and the new "generating" toast stacked on top of
	// each other. An active 'generating' entry is left alone.
	quizGeneration.items = quizGeneration.items.filter(
		(s) => s.phase === 'generating' || s.vaultId !== body.vault
	);

	function setStatus(status: DistributiveOmit<QuizGenerationStatus, 'id' | 'vaultId'>) {
		const next = { id, vaultId: body.vault, ...status } as QuizGenerationStatus;
		const idx = quizGeneration.items.findIndex((s) => s.id === id);
		if (idx === -1) quizGeneration.items.push(next);
		else quizGeneration.items[idx] = next;
	}

	setStatus({ phase: 'generating', stage: 'retrieving' });

	const controller = new AbortController();
	controllers.set(id, controller);

	const result = await runGenerationStream<QuizGenerationEvent>(
		'/api/generate/quiz',
		body,
		controller,
		(event) => {
			if (event.type === 'progress') {
				setStatus({ phase: 'generating', stage: event.stage, elapsedMs: event.elapsedMs });
			} else if (event.type === 'done') {
				setStatus({ phase: 'done', quizId: event.quizId, requested: event.requested, delivered: event.delivered });
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
	// 'cancelled': cancelQuizGeneration() already removed the entry — a
	// user-initiated cancel must never surface as an error. 'ok': the
	// stream's own terminal 'done'/'error' event already set the final
	// status above.
}

export function dismissQuizGeneration(id: string): void {
	const idx = quizGeneration.items.findIndex((s) => s.id === id);
	if (idx !== -1) quizGeneration.items.splice(idx, 1);
}

/** Cancels an in-flight generation: aborts its fetch/stream and removes its
 * toast immediately, rather than waiting for the stream loop to unwind and
 * report back — a user-initiated cancel must never be shown as an error. */
export function cancelQuizGeneration(id: string): void {
	controllers.get(id)?.abort();
	controllers.delete(id);
	dismissQuizGeneration(id);
}
