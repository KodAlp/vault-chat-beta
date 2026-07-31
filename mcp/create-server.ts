import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListVaults } from './tools/list-vaults';

/**
 * Builds and registers tools onto a McpServer without connecting a
 * transport — shared by server.ts (real stdio launch) and smoke.ts
 * (in-process InMemoryTransport test), so the tool set can never drift
 * between what's actually served and what's actually tested.
 *
 * v1 read-only surface, per the mcp-server skill: list_vaults today,
 * search_library/get_note/list_sources to follow. No study.db writes, no
 * generator tools (Ollama's single-model-in-RAM discipline is per-process
 * only — see the skill's "Üretici araçların erteleme şartları").
 */
export function createServer(): McpServer {
	const server = new McpServer(
		{ name: 'vault-chat', version: '0.1.0' },
		{ capabilities: { tools: {} } }
	);

	registerListVaults(server);

	return server;
}
