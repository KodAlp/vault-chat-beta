import type { MindMapGenerationEvent, MindMapGenerationRequest } from './types';
import type { DistributiveOmit } from './distributive-omit';

export type MindMapGenerationStatus =
	| { id: string; vaultId?: string; phase: 'generating'; stage: string; elapsedMs?: number }
	| { id: string; vaultId?: string; phase: 'done'; mindmapId: string }
	| { id: string; vaultId?: string; phase: 'error'; message: string; narrowScope?: boolean };

/** Array of entries, not a single `status` slot (Faz 13) — see
 * quiz-generation.svelte.ts's doc comment for the full rationale. */
export const mindmapGeneration = $state<{ items: MindMapGenerationStatus[] }>({
	items: []
});

export async function startMindMapGeneration(body: MindMapGenerationRequest): Promise<void> {
	const id = crypto.randomUUID();

	// See quiz-generation.svelte.ts's identical comment — drops a stale
	// error/done entry for this vault so a retry doesn't stack a new
	// "generating" toast on top of the old error toast.
	mindmapGeneration.items = mindmapGeneration.items.filter(
		(s) => s.phase === 'generating' || s.vaultId !== body.vault
	);

	function setStatus(status: DistributiveOmit<MindMapGenerationStatus, 'id' | 'vaultId'>) {
		const next = { id, vaultId: body.vault, ...status } as MindMapGenerationStatus;
		const idx = mindmapGeneration.items.findIndex((s) => s.id === id);
		if (idx === -1) mindmapGeneration.items.push(next);
		else mindmapGeneration.items[idx] = next;
	}

	setStatus({ phase: 'generating', stage: 'retrieving' });

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
					setStatus({ phase: 'generating', stage: event.stage, elapsedMs: event.elapsedMs });
				} else if (event.type === 'done') {
					setStatus({ phase: 'done', mindmapId: event.mindmapId });
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

export function dismissMindMapGeneration(id: string): void {
	const idx = mindmapGeneration.items.findIndex((s) => s.id === id);
	if (idx !== -1) mindmapGeneration.items.splice(idx, 1);
}
