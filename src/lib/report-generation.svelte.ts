import type { ReportGenerationEvent, ReportGenerationRequest } from './types';

export type ReportGenerationStatus =
	| { phase: 'idle' }
	| { phase: 'generating'; stage: string }
	| { phase: 'done'; reportId: string }
	| { phase: 'error'; message: string; narrowScope?: boolean };

/** Module-level $state — see quiz-generation.svelte.ts for the full rationale
 * (generation must survive the dialog closing; boxed in a const object since
 * Svelte 5 forbids exporting a reassigned `let` $state binding). */
export const reportGeneration = $state<{ status: ReportGenerationStatus }>({
	status: { phase: 'idle' }
});

export async function startReportGeneration(body: ReportGenerationRequest): Promise<void> {
	reportGeneration.status = { phase: 'generating', stage: 'retrieving' };

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
					reportGeneration.status = { phase: 'generating', stage: event.stage };
				} else if (event.type === 'done') {
					reportGeneration.status = { phase: 'done', reportId: event.reportId };
				} else if (event.type === 'error') {
					reportGeneration.status = {
						phase: 'error',
						message: event.message,
						narrowScope: event.narrowScope
					};
				}
			}
		}
	} catch (err) {
		reportGeneration.status = {
			phase: 'error',
			message: err instanceof Error ? err.message : 'Bilinmeyen hata'
		};
	}
}

export function dismissReportGeneration(): void {
	reportGeneration.status = { phase: 'idle' };
}
