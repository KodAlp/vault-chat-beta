import type { RequestHandler } from './$types';
import { secretStore } from '#lib/server/providers/secrets.js';
import { secretsPath } from '#lib/server/env.js';

/** L2 — how API keys are held on this machine, for the Settings > Providers
 * banner. Never returns key material, only the protection level. Gated like
 * every other /api route by hooks.server.ts's loopback + session checks. */
export const GET: RequestHandler = async () => {
	return Response.json({ mode: secretStore.mode(), platform: process.platform, secretsPath: secretsPath() });
};
