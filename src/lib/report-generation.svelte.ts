import type { ReportGenerationEvent, ReportGenerationRequest } from './types';
import type { DistributiveOmit } from './distributive-omit';
import { runGenerationStream } from './generation-stream';
import { readResponseError, localizeError } from './server-error';

export type ReportGenerationStatus =
	| { id: string; vaultId?: string; phase: 'generating'; stage: string; elapsedMs?: number }
	| { id: string; vaultId?: string; phase: 'done'; reportId: string }
	| { id: string; vaultId?: string; phase: 'error'; message: string; narrowScope?: boolean };

/** Module-level $state — see quiz-generation.svelte.ts for the full rationale
 * (generation must survive the dialog closing; an array of entries, not a
 * single `status` slot, so a second generation can't silently overwrite the
 * first's still-unread result; boxed in a const object since Svelte 5
 * forbids exporting a reassigned `let` $state binding). */
export const reportGeneration = $state<{ items: ReportGenerationStatus[] }>({
	items: []
});

/** One AbortController per in-flight generation, keyed by the same
 * client-generated id as its items entry — see quiz-generation.svelte.ts's
 * identical comment. */
const controllers = new Map<string, AbortController>();

export async function startReportGeneration(body: ReportGenerationRequest): Promise<void> {
	const id = crypto.randomUUID();

	// See quiz-generation.svelte.ts's identical comment — drops a stale
	// error/done entry for this vault so a retry doesn't stack a new
	// "generating" toast on top of the old error toast.
	reportGeneration.items = reportGeneration.items.filter(
		(s) => s.phase === 'generating' || s.vaultId !== body.vault
	);

	function setStatus(status: DistributiveOmit<ReportGenerationStatus, 'id' | 'vaultId'>) {
		const next = { id, vaultId: body.vault, ...status } as ReportGenerationStatus;
		const idx = reportGeneration.items.findIndex((s) => s.id === id);
		if (idx === -1) reportGeneration.items.push(next);
		else reportGeneration.items[idx] = next;
	}

	setStatus({ phase: 'generating', stage: 'retrieving' });

	const controller = new AbortController();
	controllers.set(id, controller);

	const result = await runGenerationStream<ReportGenerationEvent>(
		'/api/generate/report',
		body,
		controller,
		(event) => {
			if (event.type === 'progress') {
				setStatus({ phase: 'generating', stage: event.stage, elapsedMs: event.elapsedMs });
			} else if (event.type === 'done') {
				setStatus({ phase: 'done', reportId: event.reportId });
			} else if (event.type === 'error') {
				setStatus({ phase: 'error', message: localizeError(event), narrowScope: event.narrowScope });
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
	// 'cancelled': cancelReportGeneration() already removed the entry — a
	// user-initiated cancel must never surface as an error. 'ok': the
	// stream's own terminal 'done'/'error' event already set the final
	// status above.
}

export function dismissReportGeneration(id: string): void {
	const idx = reportGeneration.items.findIndex((s) => s.id === id);
	if (idx !== -1) reportGeneration.items.splice(idx, 1);
}

/** Cancels an in-flight generation: aborts its fetch/stream and removes its
 * toast immediately, rather than waiting for the stream loop to unwind and
 * report back — a user-initiated cancel must never be shown as an error. */
export function cancelReportGeneration(id: string): void {
	controllers.get(id)?.abort();
	controllers.delete(id);
	dismissReportGeneration(id);
}
