import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Liveness + token check for the MCP process: reaching this handler at all means hooks.server.ts's
 * /api/mcp/* gate (mcp-gate.ts) accepted the x-vc-mcp-token. */
export const GET: RequestHandler = async () => {
	return json({ ok: true, app: 'vault-chat' });
};
