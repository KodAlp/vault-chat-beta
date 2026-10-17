import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './env';

/**
 * What the "Connect an MCP client" settings section shows. Built from the running app's real values so the
 * user can paste it as-is. It mirrors `--print-config` of the entry file (command = absolute node, args = absolute
 * path of mcp/vault-chat-mcp.mjs in the packaged app or mcp/launch.mjs in a checkout, env.DATA_DIR = absolute data dir).
 *
 * NEVER put a secret here: the per-launch token lives in DATA_DIR/mcp-endpoint.json and the MCP server reads it itself.
 */
export type McpClientConfig =
	| { available: false }
	| {
			available: true;
			nodePath: string;
			launchPath: string;
			dataDir: string;
			/** The standard `mcpServers` block (Claude Desktop, LM Studio, Jan, generic). */
			json: string;
			/** `claude mcp add ...` one-liner for Claude Code. */
			claudeCodeCommand: string;
	  };

/** The two ways the MCP server ships: the self-contained bundle of the packaged app and launch.mjs of a source checkout. */
const BUNDLED_MCP = path.join('mcp', 'vault-chat-mcp.mjs');
const CHECKOUT_MCP = path.join('mcp', 'launch.mjs');

/**
 * Looks for the MCP entry file in each directory and its ancestors (up to `maxLevels` up), nearest first. At each
 * level the packaged app's bundle (<dist-server>/mcp/vault-chat-mcp.mjs, built by scripts/build-mcp.mjs) is
 * checked before a checkout's mcp/launch.mjs; since only one of them exists in any given tree, "nearest" is what
 * tells a checkout from a packaged install. Pure (the existence check is a parameter) so it is testable.
 */
export function locateLaunchScript(startDirs: string[], exists: (p: string) => boolean, maxLevels = 8): string | null {
	for (const start of startDirs) {
		let dir = path.resolve(start);
		for (let level = 0; level <= maxLevels; level++) {
			for (const rel of [BUNDLED_MCP, CHECKOUT_MCP]) {
				const candidate = path.join(dir, rel);
				if (exists(candidate)) return candidate;
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}

/**
 * The packaged app runs from <dist-server>/build/server/... with cwd = dist-server (so cwd finds the bundle), and
 * a dev server or `node build` from a checkout has the repo above this file (and usually as cwd). The module's
 * own location is tried second because cwd is arbitrary in tests and tools.
 */
export function findLaunchScript(): string | null {
	return locateLaunchScript([process.cwd(), path.dirname(fileURLToPath(import.meta.url))], fs.existsSync);
}

/** Quotes one shell argument for a terminal (double quotes work in cmd, PowerShell and POSIX shells for these paths). */
function quoteArg(s: string): string {
	return `"${s.replace(/"/g, '\\"')}"`;
}

export function buildMcpClientConfig(launchPath: string | null, nodePath: string, data: string): McpClientConfig {
	if (!launchPath) return { available: false };
	const block = {
		mcpServers: {
			'vault-chat': { command: nodePath, args: [launchPath], env: { DATA_DIR: data } }
		}
	};
	return {
		available: true,
		nodePath,
		launchPath,
		dataDir: data,
		json: JSON.stringify(block, null, 2),
		claudeCodeCommand: `claude mcp add --scope user -e DATA_DIR=${quoteArg(data)} vault-chat -- ${quoteArg(nodePath)} ${quoteArg(launchPath)}`
	};
}

export function getMcpClientConfig(): McpClientConfig {
	return buildMcpClientConfig(findLaunchScript(), process.execPath, dataDir());
}
