import type { SlidesGenerationEvent, SlidesGenerationRequest } from './types';
import type { DistributiveOmit } from './distributive-omit';

export type SlidesGenerationStatus =
	| { id: string; vaultId?: string; phase: 'generating'; stage: string; elapsedMs?: number }
	| { id: string; vaultId?: string; phase: 'done'; slideDeckId: string }
	| { id: string; vaultId?: string; phase: 'error'; message: string; narrowScope?: boolean };

/** Array of entries, not a single `status` slot (Faz 13) — see
 * quiz-generation.svelte.ts's doc comment for the full rationale. */
export const slidesGeneration = $state<{ items: SlidesGenerationStatus[] }>({
	items: []
});

export async function startSlidesGeneration(body: SlidesGenerationRequest): Promise<void> {
	const id = crypto.randomUUID();
	function setStatus(status: DistributiveOmit<SlidesGenerationStatus, 'id' | 'vaultId'>) {
		const next = { id, vaultId: body.vault, ...status } as SlidesGenerationStatus;
		const idx = slidesGeneration.items.findIndex((s) => s.id === id);
		if (idx === -1) slidesGeneration.items.push(next);
		else slidesGeneration.items[idx] = next;
	}

	setStatus({ phase: 'generating', stage: 'retrieving' });

	try {
		const res = await fetch('/api/generate/slides', {
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
				const event = JSON.parse(line.slice(5)) as SlidesGenerationEvent;
				if (event.type === 'progress') {
					setStatus({ phase: 'generating', stage: event.stage, elapsedMs: event.elapsedMs });
				} else if (event.type === 'done') {
					setStatus({ phase: 'done', slideDeckId: event.slideDeckId });
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

export function dismissSlidesGeneration(id: string): void {
	const idx = slidesGeneration.items.findIndex((s) => s.id === id);
	if (idx !== -1) slidesGeneration.items.splice(idx, 1);
}
