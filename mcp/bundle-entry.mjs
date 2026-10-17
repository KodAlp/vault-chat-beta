// Entry of the self-contained MCP bundle (scripts/build-mcp.mjs -> dist-server/mcp/vault-chat-mcp.mjs).
// The packaged desktop app has no repo and no tsx, so this does what launch.mjs does, minus the loader:
// the same stdout -> stderr redirect, the same DATA_DIR handling, the same --print-config.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedAppDataDir } from './setup-lib.mjs';

// stdout carries JSON-RPC frames under the stdio transport; see launch.mjs. Everything below is
// imported dynamically, after this line, so no module of the bundled import graph can log to stdout first.
console.log = console.info = console.debug = (...args) => console.error(...args);

const bundlePath = fileURLToPath(import.meta.url);
// The bundle lives at <dist-server>/mcp/vault-chat-mcp.mjs; dist-server is also the packaged sidecar's cwd.
const serverRoot = path.dirname(path.dirname(bundlePath));

// Modules in the graph still read process.cwd()/data (config-store's providers.default fallback, the
// bundled providers.json seed). An MCP client starts us in an arbitrary cwd, so pin it to the server root,
// exactly what the sidecar runs with. DATA_DIR below is absolute, so this never moves user data.
try {
	process.chdir(serverRoot);
} catch {
	// best effort: only the "no providers.json yet" fallback depends on it
}

// An explicit DATA_DIR always wins (a relative one resolves against the server root, like launch.mjs
// resolves against the repo root). Unset: the installed desktop app's data dir (what the Tauri sidecar
// gets as DATA_DIR), not <repo>/data, which does not exist in a packaged install.
process.env.DATA_DIR =
	process.env.DATA_DIR && process.env.DATA_DIR.length > 0
		? path.resolve(serverRoot, process.env.DATA_DIR)
		: installedAppDataDir({ platform: process.platform, env: process.env, home: os.homedir() });

if (process.argv.includes('--print-config')) {
	const block = {
		mcpServers: {
			'vault-chat': {
				// Absolute node: GUI-launched MCP clients (Claude Desktop on macOS) don't have nvm/Homebrew on PATH.
				command: process.execPath,
				args: [bundlePath],
				env: { DATA_DIR: process.env.DATA_DIR }
			}
		}
	};
	process.stdout.write(`${JSON.stringify(block, null, 2)}\n`);
	process.exit(0);
}

const { listVaults } = await import('../src/lib/server/vaults.ts');
console.error(`[vault-chat-mcp] DATA_DIR=${process.env.DATA_DIR} vaults=${listVaults().length}`);

await import('./server.ts');
