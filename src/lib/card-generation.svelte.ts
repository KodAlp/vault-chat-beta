import type { CardGenerationEvent, CardGenerationRequest } from './types';
import type { DistributiveOmit } from './distributive-omit';

export type CardGenerationStatus =
	| { id: string; phase: 'generating'; stage: string }
	| { id: string; phase: 'done'; deckId: string }
	| { id: string; phase: 'error'; message: string; narrowScope?: boolean };

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

export async function startCardGeneration(body: CardGenerationRequest): Promise<void> {
	const id = crypto.randomUUID();
	function setStatus(status: DistributiveOmit<CardGenerationStatus, 'id'>) {
		const next = { id, ...status } as CardGenerationStatus;
		const idx = cardGeneration.items.findIndex((s) => s.id === id);
		if (idx === -1) cardGeneration.items.push(next);
		else cardGeneration.items[idx] = next;
	}

	setStatus({ phase: 'generating', stage: 'retrieving' });

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
					setStatus({ phase: 'generating', stage: event.stage });
				} else if (event.type === 'done') {
					setStatus({ phase: 'done', deckId: event.deckId });
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

export function dismissCardGeneration(id: string): void {
	const idx = cardGeneration.items.findIndex((s) => s.id === id);
	if (idx !== -1) cardGeneration.items.splice(idx, 1);
}
