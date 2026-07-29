import type { QuizGenerationEvent, QuizGenerationRequest } from './types';

export type QuizGenerationStatus =
	| { phase: 'idle' }
	| { phase: 'generating'; stage: string }
	| { phase: 'done'; quizId: string }
	| { phase: 'error'; message: string };

/**
 * Module-level $state, not component-local — generation must survive the
 * dialog that started it being closed (and the user navigating elsewhere
 * entirely) rather than blocking the screen for the 20s-2min a real
 * generation can take. Any page can render a widget reading this; the
 * fetch loop itself lives here so it isn't tied to any one component's
 * lifetime.
 */
export let quizGenerationStatus = $state<QuizGenerationStatus>({ phase: 'idle' });

export async function startQuizGeneration(body: QuizGenerationRequest): Promise<void> {
	quizGenerationStatus = { phase: 'generating', stage: 'retrieving' };

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
					quizGenerationStatus = { phase: 'generating', stage: event.stage };
				} else if (event.type === 'done') {
					quizGenerationStatus = { phase: 'done', quizId: event.quizId };
				} else if (event.type === 'error') {
					quizGenerationStatus = { phase: 'error', message: event.message };
				}
			}
		}
	} catch (err) {
		quizGenerationStatus = {
			phase: 'error',
			message: err instanceof Error ? err.message : 'Bilinmeyen hata'
		};
	}
}

export function dismissQuizGeneration(): void {
	quizGenerationStatus = { phase: 'idle' };
}
