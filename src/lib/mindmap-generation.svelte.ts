import type { MindMapGenerationEvent, MindMapGenerationRequest } from './types';

export type MindMapGenerationStatus =
	| { phase: 'idle' }
	| { phase: 'generating'; stage: string; elapsedMs?: number }
	| { phase: 'done'; mindmapId: string }
	| { phase: 'error'; message: string };

export const mindmapGeneration = $state<{ status: MindMapGenerationStatus }>({
	status: { phase: 'idle' }
});

export async function startMindMapGeneration(body: MindMapGenerationRequest): Promise<void> {
	mindmapGeneration.status = { phase: 'generating', stage: 'retrieving' };

	try {
		const res = await fetch('/api/generate/mindmap', {
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
				const event = JSON.parse(line.slice(5)) as MindMapGenerationEvent;
				if (event.type === 'progress') {
					mindmapGeneration.status = { phase: 'generating', stage: event.stage, elapsedMs: event.elapsedMs };
				} else if (event.type === 'done') {
					mindmapGeneration.status = { phase: 'done', mindmapId: event.mindmapId };
				} else if (event.type === 'error') {
					mindmapGeneration.status = { phase: 'error', message: event.message };
				}
			}
		}
	} catch (err) {
		mindmapGeneration.status = {
			phase: 'error',
			message: err instanceof Error ? err.message : 'Bilinmeyen hata'
		};
	}
}

export function dismissMindMapGeneration(): void {
	mindmapGeneration.status = { phase: 'idle' };
}
