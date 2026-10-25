import type { RequestHandler } from './$types';
import { clearSmallTalk, listSmallTalk, smallTalkGateActive, teachSmallTalk } from '#lib/server/smalltalk-runtime.js';
import { MAX_PHRASE_CHARS } from '#lib/server/smalltalk-store.js';
import { fail } from '#lib/server/app-error.js';

/** The user's learned small-talk phrases (see smalltalk-gate.ts) — user-level, not per vault. */
export const GET: RequestHandler = async () => {
	// gateActive false = the configured embedding model is not the one the gate was calibrated for (or none).
	return Response.json({ phrases: listSmallTalk(), gateActive: smallTalkGateActive() });
};

/** "Kaynaklar alakasız": teach that this message is small talk. `stored: false` means it was
 * not kept (a confirmed question, or too long to be small talk) — not an error. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
	const text = typeof body?.text === 'string' ? body.text.trim() : '';
	if (!text) fail('VALIDATION_REQUIRED', { field: 'text' });
	if (text.length > MAX_PHRASE_CHARS) return Response.json({ ok: true, stored: false });
	try {
		return Response.json({ ok: true, stored: await teachSmallTalk(text), gateActive: smallTalkGateActive() });
	} catch (err) {
		fail('SMALLTALK_LEARN_FAILED', { detail: err instanceof Error ? err.message : String(err) }, 502);
	}
};

/** Forget everything learned and switch every seed back on. */
export const DELETE: RequestHandler = async () => {
	return Response.json({ ok: true, removed: clearSmallTalk() });
};
