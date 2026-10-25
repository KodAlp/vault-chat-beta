import type { RequestHandler } from './$types';
import { getMcpClientConfig } from '#lib/server/mcp-client-config.js';

/** Ready-to-paste MCP client config for the settings page. Session-gated like the rest of /api/settings (not under /api/mcp/). */
export const GET: RequestHandler = async () => Response.json(getMcpClientConfig());
