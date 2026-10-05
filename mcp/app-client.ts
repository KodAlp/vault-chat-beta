import { dataDir } from '../src/lib/server/env';
import { readMcpEndpoint, type McpEndpointInfo } from '../src/lib/server/mcp-endpoint';
import { ToolError } from './errors';

/**
 * HTTP client for the running Vault Chat app — the only way the write tools
 * (create_vault, import_source, list_pending_imports) act. This process never
 * writes library files or registries itself: the app owns the registry race,
 * the conversion queue, the SSRF guard and the staging area, and the user
 * confirms in the app before anything enters the library.
 *
 * Discovery: DATA_DIR/mcp-endpoint.json (written by the app at startup, see
 * src/lib/server/mcp-endpoint.ts) holds the loopback URL and a per-launch MCP
 * token, sent as `x-vc-mcp-token`. It is re-read on EVERY call, so an app
 * restart (new port, new token) needs no MCP restart. No Origin header is
 * ever sent (the app refuses any Origin on /api/mcp/*: that marks a browser).
 * Global fetch only; no new dependencies.
 */

const REQUEST_TIMEOUT_MS = 15_000;

const NOT_RUNNING_MESSAGE =
	'Vault Chat is not running. Start the Vault Chat app (it publishes mcp-endpoint.json when it starts) and retry.';

/** Signal 0 only checks existence; EPERM means the process exists but belongs to someone else — still alive. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function currentEndpoint(): McpEndpointInfo {
	const info = readMcpEndpoint(dataDir());
	if (!info || !pidAlive(info.pid)) throw new ToolError('APP_NOT_RUNNING', NOT_RUNNING_MESSAGE);
	return info;
}

/** What each app error means for an agent, in plain English. Unlisted codes still pass through with their params. */
const HINTS: Record<string, string> = {
	MCP_IMPORT_ROOTS_EMPTY:
		'No folder is allowed for MCP file imports yet. Ask the user to add a folder in the Vault Chat settings, or import a URL instead.',
	MCP_PATH_NOT_ALLOWED: 'That file is outside the folders the user allowed for MCP imports (Vault Chat settings).',
	MCP_PATH_INVALID:
		'The path must be an absolute path to an existing regular file: no symlinks, no ".." segments, not a directory.',
	MCP_VAULT_NOT_EXPOSED: 'That vault is not open to MCP clients. The user can open it in Settings → Vaults.',
	MCP_TOKEN_REQUIRED: 'The app rejected the MCP token (it may have just restarted). Retry the call.',
	MCP_API_DISABLED: 'The app was started without MCP write support. Restart Vault Chat and retry.',
	UNSUPPORTED_FILE_TYPE: 'That file type cannot be converted.',
	FILE_TOO_LARGE: 'That file is over the upload size limit.',
	LINK_INVALID: 'That is not a valid URL.',
	LINK_PROTOCOL_UNSUPPORTED: 'Only http and https URLs can be imported.',
	REQUEST_FAILED: 'The app is busy; wait for pending imports to finish and retry.',
	VAULT_NAME_EMPTY: 'The vault name must not be empty.'
};

function toToolError(status: number, body: unknown): ToolError {
	const b = (typeof body === 'object' && body !== null ? body : {}) as { code?: unknown; params?: unknown; message?: unknown };
	let code = typeof b.code === 'string' ? b.code : undefined;
	const params = typeof b.params === 'object' && b.params !== null ? (b.params as Record<string, unknown>) : undefined;
	const entity = params?.entity;

	if (code === 'NOT_FOUND' && entity === 'vault') code = 'VAULT_NOT_FOUND';
	else if (code === 'MCP_VAULT_NOT_EXPOSED') code = 'VAULT_NOT_EXPOSED';
	else if (code === 'MCP_TOKEN_REQUIRED' || code === 'MCP_API_DISABLED') {
		return new ToolError('APP_UNAUTHORIZED', HINTS[code]);
	}

	if (!code) {
		const text = typeof b.message === 'string' ? b.message : `HTTP ${status}`;
		return new ToolError('APP_ERROR', `The app answered ${status}: ${text}`);
	}

	const hint = HINTS[code === 'VAULT_NOT_EXPOSED' ? 'MCP_VAULT_NOT_EXPOSED' : code];
	const detail = params && Object.keys(params).length > 0 ? ` ${JSON.stringify(params)}` : '';
	return new ToolError(code, `${hint ?? 'The app rejected the request.'}${detail}`);
}

/**
 * One JSON request to the app. Returns the parsed 2xx body; throws ToolError
 * otherwise (APP_NOT_RUNNING for a missing/stale endpoint file or a refused
 * connection, APP_TIMEOUT after 15 s, the app's own coded errors passed
 * through). `pathAndQuery` starts with `/api/mcp/`.
 */
export async function appRequest<T>(method: 'GET' | 'POST', pathAndQuery: string, body?: unknown): Promise<T> {
	const info = currentEndpoint();
	let res: Response;
	try {
		res = await fetch(`${info.url}${pathAndQuery}`, {
			method,
			headers: {
				'x-vc-mcp-token': info.mcpToken,
				...(body !== undefined ? { 'content-type': 'application/json' } : {})
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch (err) {
		if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
			throw new ToolError('APP_TIMEOUT', `The Vault Chat app did not answer within ${REQUEST_TIMEOUT_MS / 1000} s.`);
		}
		// ECONNREFUSED and friends: the file is there but nothing listens (crashed app, reused pid).
		throw new ToolError('APP_NOT_RUNNING', NOT_RUNNING_MESSAGE);
	}

	let payload: unknown = null;
	try {
		payload = await res.json();
	} catch {
		// non-JSON body (e.g. an HTML error page) — handled below by status
	}
	if (!res.ok) throw toToolError(res.status, payload);
	if (payload === null) throw new ToolError('APP_ERROR', `The app answered ${res.status} without a JSON body.`);
	return payload as T;
}
