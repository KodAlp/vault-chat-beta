import type { CardGenerationEvent, CardGenerationRequest } from './types';

export type CardGenerationStatus =
	| { phase: 'idle' }
	| { phase: 'generating'; stage: string }
	| { phase: 'done'; deckId: string }
	| { phase: 'error'; message: string };

/**
 * Module-level $state, not component-local — same reasoning as
 * quiz-generation.svelte.ts: generation must survive the dialog that
 * started it closing (and the user navigating away) rather than blocking
 * the screen for the 20s-2min a real generation takes.
 *
 * Boxed in a const object on purpose: Svelte 5 forbids exporting a `let`
 * $state binding that gets reassigned. Consumers read
 * `cardGeneration.status`, never reassign `cardGeneration` itself.
 */
export const cardGeneration = $state<{ status: CardGenerationStatus }>({
	status: { phase: 'idle' }
});

export async function startCardGeneration(body: CardGenerationRequest): Promise<void> {
	cardGeneration.status = { phase: 'generating', stage: 'retrieving' };

	try {
		const res = await fetch('/api/generate/cards', {
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
				const event = JSON.parse(line.slice(5)) as CardGenerationEvent;
				if (event.type === 'progress') {
					cardGeneration.status = { phase: 'generating', stage: event.stage };
				} else if (event.type === 'done') {
					cardGeneration.status = { phase: 'done', deckId: event.deckId };
				} else if (event.type === 'error') {
					cardGeneration.status = { phase: 'error', message: event.message };
				}
			}
		}
	} catch (err) {
		cardGeneration.status = {
			phase: 'error',
			message: err instanceof Error ? err.message : 'Bilinmeyen hata'
		};
	}
}

export function dismissCardGeneration(): void {
	cardGeneration.status = { phase: 'idle' };
}
