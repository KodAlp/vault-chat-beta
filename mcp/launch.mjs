#!/usr/bin/env node
// Plain .mjs, zero TypeScript, so this starts with no loader involved.
// MCP clients spawn this file directly — see the mcp-server skill for the
// exact contract this follows.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Never process.cwd() — an MCP client spawns this with an arbitrary cwd
// (Claude Desktop's is unrelated to this repo entirely).
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// stdout carries JSON-RPC frames under the stdio transport. A single
// console.log from anywhere in the import graph (migrateVaults.ts and all
// of indexer/ are full of them) corrupts the stream into an unparseable
// mess on the client side. Redirect before importing anything else.
console.log = console.info = console.debug = (...args) => console.error(...args);

try {
	// Node 22 builtin, non-throwing on missing files by default, but wrapped
	// anyway since older/odd Node builds may not have it.
	process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
	// .env is optional; verified this never overrides an already-set var
	// (same precedence Vite's own loadEnv uses), so a Claude config's
	// explicit `env` block always wins regardless.
}

// Kills vaults.ts's/registry.ts's path.resolve(process.cwd(), ...)
// assumption at the source — DATA_DIR is always absolute from here on.
process.env.DATA_DIR = path.resolve(
	repoRoot,
	process.env.DATA_DIR && process.env.DATA_DIR.length > 0 ? process.env.DATA_DIR : 'data'
);

const printConfig = process.argv.includes('--print-config');

if (printConfig) {
	const block = {
		mcpServers: {
			'vault-chat': {
				// Absolute path of the node running this script: Claude Desktop on macOS starts MCP servers with
				// the GUI PATH, which doesn't include Homebrew/nvm/fnm node, so a bare "node" isn't found there.
				command: process.execPath,
				args: [fileURLToPath(new URL('./launch.mjs', import.meta.url))],
				env: { DATA_DIR: process.env.DATA_DIR }
			}
		}
	};
	// This is the one deliberate stdout write in --print-config mode —
	// the process exits right after, so it never collides with the
	// stdio transport (which is never started in this branch).
	process.stdout.write(`${JSON.stringify(block, null, 2)}\n`);
	process.exit(0);
}

// tsx is a devDependency, not a runtime one — MCP clients spawn this
// directly with no build step. Bare specifier resolves relative to this
// file's own location (vault-chat/node_modules/tsx), which is why the
// import happens here and not any earlier.
const { register } = await import('tsx/esm/api');
register();

const { listVaults } = await import('../src/lib/server/vaults.ts');
console.error(`[vault-chat-mcp] DATA_DIR=${process.env.DATA_DIR} vaults=${listVaults().length}`);

await import('./server.ts');
