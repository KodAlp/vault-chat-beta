import type { SlidesGenerationEvent, SlidesGenerationRequest } from './types';

export type SlidesGenerationStatus =
	| { phase: 'idle' }
	| { phase: 'generating'; stage: string }
	| { phase: 'done'; slideDeckId: string }
	| { phase: 'error'; message: string };

export const slidesGeneration = $state<{ status: SlidesGenerationStatus }>({
	status: { phase: 'idle' }
});

export async function startSlidesGeneration(body: SlidesGenerationRequest): Promise<void> {
	slidesGeneration.status = { phase: 'generating', stage: 'retrieving' };

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
					slidesGeneration.status = { phase: 'generating', stage: event.stage };
				} else if (event.type === 'done') {
					slidesGeneration.status = { phase: 'done', slideDeckId: event.slideDeckId };
				} else if (event.type === 'error') {
					slidesGeneration.status = { phase: 'error', message: event.message };
				}
			}
		}
	} catch (err) {
		slidesGeneration.status = {
			phase: 'error',
			message: err instanceof Error ? err.message : 'Bilinmeyen hata'
		};
	}
}

export function dismissSlidesGeneration(): void {
	slidesGeneration.status = { phase: 'idle' };
}
