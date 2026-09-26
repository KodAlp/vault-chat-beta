import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteMemory, editMemory } from '$lib/server/memory-runtime';
import type { MemoryNoteView } from '$lib/types';
import { fail } from '$lib/server/app-error';

/** Edits a note: inserts a new row and supersedes the old one (memory-store.ts) — not a mutation. */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => null)) as { value?: unknown } | null;
	const value = typeof body?.value === 'string' ? body.value.trim() : '';
	if (!value) fail('VALIDATION_REQUIRED', { field: 'value' });
	const edited = editMemory(params.id, value);
	if (!edited) fail('NOT_FOUND', { entity: 'memory' }, 404);
	const note: MemoryNoteView = { id: edited.id, type: edited.type, domain: edited.domain, value: edited.value, createdAt: edited.createdAt };
	return json({ note });
};

/** Soft delete: sets deleted_at, the row itself is kept (memory-store.ts). */
export const DELETE: RequestHandler = async ({ params }) => {
	if (!deleteMemory(params.id)) fail('NOT_FOUND', { entity: 'memory' }, 404);
	return json({ ok: true });
};
