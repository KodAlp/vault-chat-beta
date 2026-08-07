import type { QuizGenerationEvent, QuizGenerationRequest } from './types';
import type { DistributiveOmit } from './distributive-omit';

export type QuizGenerationStatus =
	| { id: string; phase: 'generating'; stage: string }
	| { id: string; phase: 'done'; quizId: string }
	| { id: string; phase: 'error'; message: string; narrowScope?: boolean };

/**
 * Module-level $state, not component-local — generation must survive the
 * dialog that started it being closed (and the user navigating elsewhere
 * entirely) rather than blocking the screen for the 20s-2min a real
 * generation can take. Any page can render a widget reading this; the
 * fetch loop itself lives here so it isn't tied to any one component's
 * lifetime.
 *
 * An array of entries, not a single `status` slot (Faz 13) — the old
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

export async function startQuizGeneration(body: QuizGenerationRequest): Promise<void> {
	const id = crypto.randomUUID();
	function setStatus(status: DistributiveOmit<QuizGenerationStatus, 'id'>) {
		const next = { id, ...status } as QuizGenerationStatus;
		const idx = quizGeneration.items.findIndex((s) => s.id === id);
		if (idx === -1) quizGeneration.items.push(next);
		else quizGeneration.items[idx] = next;
	}

	setStatus({ phase: 'generating', stage: 'retrieving' });

	try {
		const res = await fetch('/api/generate/quiz', {
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
				const event = JSON.parse(line.slice(5)) as QuizGenerationEvent;
				if (event.type === 'progress') {
					setStatus({ phase: 'generating', stage: event.stage });
				} else if (event.type === 'done') {
					setStatus({ phase: 'done', quizId: event.quizId });
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

export function dismissQuizGeneration(id: string): void {
	const idx = quizGeneration.items.findIndex((s) => s.id === id);
	if (idx !== -1) quizGeneration.items.splice(idx, 1);
}
