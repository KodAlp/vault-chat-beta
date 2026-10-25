import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { addMemory, listMemory } from '$lib/server/memory-runtime';
import type { MemoryType } from '$lib/server/memory-store';
import type { MemoryNoteView } from '$lib/types';
import { fail } from '$lib/server/app-error';

const TYPES: readonly MemoryType[] = ['GLOBAL', 'PERSONAL'];

function toView(n: ReturnType<typeof listMemory>[number]): MemoryNoteView {
	return { id: n.id, type: n.type, domain: n.domain, value: n.value, createdAt: n.createdAt };
}

/** The user's manual memory notes — user-level, not per vault (see memory-store.ts). */
export const GET: RequestHandler = () => {
	return json({ notes: listMemory().map(toView) });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { type?: unknown; domain?: unknown; value?: unknown } | null;
	const type = body?.type;
	const value = typeof body?.value === 'string' ? body.value.trim() : '';
	if (typeof type !== 'string' || !TYPES.includes(type as MemoryType)) fail('MEMORY_TYPE_INVALID');
	if (!value) fail('VALIDATION_REQUIRED', { field: 'value' });
	const domain = typeof body?.domain === 'string' && body.domain.trim() ? body.domain.trim() : null;
	return json({ note: toView(addMemory({ type: type as MemoryType, domain, value })) });
};
