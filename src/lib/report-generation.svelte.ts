import type { ReportGenerationEvent, ReportGenerationRequest } from './types';
import type { DistributiveOmit } from './distributive-omit';

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

export async function startReportGeneration(body: ReportGenerationRequest): Promise<void> {
	const id = crypto.randomUUID();
	function setStatus(status: DistributiveOmit<ReportGenerationStatus, 'id' | 'vaultId'>) {
		const next = { id, vaultId: body.vault, ...status } as ReportGenerationStatus;
		const idx = reportGeneration.items.findIndex((s) => s.id === id);
		if (idx === -1) reportGeneration.items.push(next);
		else reportGeneration.items[idx] = next;
	}

	setStatus({ phase: 'generating', stage: 'retrieving' });

	try {
		const res = await fetch('/api/generate/report', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok || !res.body) throw new Error(`İstek başarısız (${res.status})`);

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split('\n\n');
			buffer = parts.pop() ?? '';
			for (const part of parts) {
				const line = part.trim();
				if (!line.startsWith('data:')) continue;
				const event = JSON.parse(line.slice(5)) as ReportGenerationEvent;
				if (event.type === 'progress') {
					setStatus({ phase: 'generating', stage: event.stage, elapsedMs: event.elapsedMs });
				} else if (event.type === 'done') {
					setStatus({ phase: 'done', reportId: event.reportId });
				} else if (event.type === 'error') {
					setStatus({ phase: 'error', message: event.message, narrowScope: event.narrowScope });
				}
			}
		}
	} catch (err) {
		setStatus({
			phase: 'error',
			message: err instanceof Error ? err.message : 'Bilinmeyen hata'
		});
	}
}

export function dismissReportGeneration(id: string): void {
	const idx = reportGeneration.items.findIndex((s) => s.id === id);
	if (idx !== -1) reportGeneration.items.splice(idx, 1);
}
