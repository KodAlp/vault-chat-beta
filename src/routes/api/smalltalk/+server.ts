import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clearSmallTalk, listSmallTalk, teachSmallTalk } from '$lib/server/smalltalk-runtime';
import { MAX_PHRASE_CHARS } from '$lib/server/smalltalk-store';

/** The user's learned small-talk phrases (see smalltalk-gate.ts) — user-level, not per vault. */
export const GET: RequestHandler = async () => {
	return json({ phrases: listSmallTalk() });
};

/** "Kaynaklar alakasız": teach that this message is small talk. `stored: false` means it was
 * not kept (a confirmed question, or too long to be small talk) — not an error. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
	const text = typeof body?.text === 'string' ? body.text.trim() : '';
	if (!text) error(400, 'text gerekli');
	if (text.length > MAX_PHRASE_CHARS) return json({ ok: true, stored: false });
	try {
		return json({ ok: true, stored: await teachSmallTalk(text) });
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Öğrenilemedi');
	}
};

/** Forget everything learned and switch every seed back on. */
export const DELETE: RequestHandler = async () => {
	return json({ ok: true, removed: clearSmallTalk() });
};
