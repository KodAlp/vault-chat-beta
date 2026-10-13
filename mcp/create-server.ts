import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListVaults } from './tools/list-vaults';
import { registerSearchLibrary } from './tools/search-library';
import { registerGetNote } from './tools/get-note';
import { registerListSources } from './tools/list-sources';
import { registerListDomains } from './tools/list-domains';
import { registerCreateVault } from './tools/create-vault';
import { registerImportSource } from './tools/import-source';
import { registerListPendingImports } from './tools/list-pending-imports';
import { registerEditNote } from './tools/edit-note';

/**
 * Builds and registers tools onto a McpServer without connecting a
 * transport — shared by server.ts (real stdio launch) and smoke.ts
 * (in-process InMemoryTransport test), so the tool set can never drift
 * between what's actually served and what's actually tested.
 *
 * Reads go straight to the files (list_vaults, search_library, get_note,
 * list_sources) and work with the app closed. Writes never touch files from
 * this process: create_vault, import_source and list_pending_imports call the
 * RUNNING app's local HTTP API (app-client.ts, found via
 * DATA_DIR/mcp-endpoint.json), so there is one writer, the app's own
 * validation applies, and imports only land in a staging list that the user
 * confirms in the app. No study.db writes, no generator tools (Ollama's
 * single-model-in-RAM discipline is per-process only — see the skill's
 * "Üretici araçların erteleme şartları").
 */
export function createServer(): McpServer {
	const server = new McpServer(
		{ name: 'vault-chat', version: '0.1.0' },
		{ capabilities: { tools: {} } }
	);

	registerListVaults(server);
	registerSearchLibrary(server);
	registerGetNote(server);
	registerListSources(server);
	registerListDomains(server);
	registerCreateVault(server);
	registerImportSource(server);
	registerListPendingImports(server);
	registerEditNote(server);

	return server;
}
