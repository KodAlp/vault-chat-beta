import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getMcpClientConfig } from '$lib/server/mcp-client-config';

/** Ready-to-paste MCP client config for the settings page. Session-gated like the rest of /api/settings (not under /api/mcp/). */
export const GET: RequestHandler = async () => json(getMcpClientConfig());
