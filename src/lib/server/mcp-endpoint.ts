import fs from 'node:fs';
import path from 'node:path';

/**
 * DATA_DIR/mcp-endpoint.json — how the MCP stdio process (mcp/, a separate
 * process started by Claude Desktop/Code) finds the RUNNING app so its write
 * tools can go through the app's local HTTP API instead of touching files
 * itself.
 *
 * Who writes it: the dev server (a Vite plugin in vite.config.ts) and the
 * Tauri shell (spawn_sidecar in src-tauri/src/lib.rs) — both after the port
 * is known, both with a fresh random token per launch. The file carries the
 * MCP token ONLY (it grants /api/mcp/* and nothing else, see mcp-gate.ts);
 * the browser session token (VC_SESSION_TOKEN) never goes in here.
 *
 * Pure node: no SvelteKit/$lib imports, because vite.config.ts and mcp/ both
 * load this file by relative path outside the SvelteKit runtime.
 */
export interface McpEndpointInfo {
	/** `http://127.0.0.1:<port>` — always loopback. */
	url: string;
	/** 64 hex chars. Sent by the MCP process as `x-vc-mcp-token`. */
	mcpToken: string;
	/** Process that owns the file; a reader treats a dead pid as "app not running". */
	pid: number;
	startedAt: string;
}

export const MCP_ENDPOINT_FILE = 'mcp-endpoint.json';

export function mcpEndpointPath(dataDir: string): string {
	return path.join(dataDir, MCP_ENDPOINT_FILE);
}

/** Atomic (tmp file + rename) and owner-only (0o600; Windows ignores the mode
 * and relies on the per-user profile ACL). A crash mid-write never leaves a
 * half-written file for a reader to choke on. */
export function writeMcpEndpoint(dataDir: string, info: McpEndpointInfo): void {
	fs.mkdirSync(dataDir, { recursive: true });
	const p = mcpEndpointPath(dataDir);
	const tmp = `${p}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
	fs.renameSync(tmp, p);
}

/** Missing, unparsable or wrongly-shaped file all read as `null`. */
export function readMcpEndpoint(dataDir: string): McpEndpointInfo | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(mcpEndpointPath(dataDir), 'utf-8')) as Partial<McpEndpointInfo>;
		if (
			typeof parsed.url === 'string' &&
			typeof parsed.mcpToken === 'string' &&
			parsed.mcpToken.length > 0 &&
			typeof parsed.pid === 'number' &&
			Number.isInteger(parsed.pid) &&
			typeof parsed.startedAt === 'string'
		) {
			return { url: parsed.url, mcpToken: parsed.mcpToken, pid: parsed.pid, startedAt: parsed.startedAt };
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Removes the file only when it still belongs to the caller: another app
 * instance (or a restarted dev server in the same pid) may have replaced it
 * since, and deleting THEIR file would silently disconnect MCP. `token`, when
 * given, narrows the match further (a Vite config restart re-uses the pid but
 * mints a new token). Returns whether a file was removed. Never throws.
 */
export function removeMcpEndpoint(dataDir: string, pid: number, token?: string): boolean {
	try {
		const current = readMcpEndpoint(dataDir);
		if (!current || current.pid !== pid) return false;
		if (token !== undefined && current.mcpToken !== token) return false;
		fs.rmSync(mcpEndpointPath(dataDir), { force: true });
		return true;
	} catch {
		return false;
	}
}
