import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './env';

/**
 * What the "Connect an MCP client" settings section shows. Built from the running app's real values so the
 * user can paste it as-is. It mirrors `node mcp/launch.mjs --print-config` (command = absolute node, args =
 * absolute launch.mjs, env.DATA_DIR = absolute data dir).
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

/** The MCP server is not bundled in the packaged desktop app: it only exists in a source checkout. */
export function findLaunchScript(): string | null {
	const candidates = [
		path.resolve(process.cwd(), 'mcp', 'launch.mjs'),
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'mcp', 'launch.mjs')
	];
	return candidates.find((p) => fs.existsSync(p)) ?? null;
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
