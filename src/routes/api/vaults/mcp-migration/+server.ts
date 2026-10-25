import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveMcpMigration } from '#lib/server/vaults.js';

/** One-time migration answer — see vaults.ts's RegistryFile doc comment.
 * Idempotent: calling it again after mcpMigrationAsked is already true just
 * re-applies exposeAll to every vault, which is harmless (the settings page
 * only ever shows the prompt once, but a stray double-submit must not do
 * anything worse than a redundant write). */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { exposeAll: boolean };
	resolveMcpMigration(body.exposeAll === true);
	return json({ ok: true });
};
