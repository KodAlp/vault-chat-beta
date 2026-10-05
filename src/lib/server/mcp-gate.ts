import { timingSafeEqualString } from './session-gate';

/**
 * Pure decision for requests under /api/mcp/ — extracted out of
 * hooks.server.ts's `handle` so it can be unit-tested without SvelteKit
 * (same split as session-gate.ts).
 *
 * Least privilege: these paths are authenticated ONLY by the MCP token
 * (header `x-vc-mcp-token`, from DATA_DIR/mcp-endpoint.json) and BYPASS the
 * browser session-cookie gate; conversely the MCP token is worthless on any
 * other path (hooks.server.ts only consults this module for /api/mcp/*, every
 * other path still needs the session gate). A browser always attaches an
 * Origin header to cross-origin fetches and to every non-GET request, while an
 * MCP client never does — so any Origin here means a web page is trying to
 * reach the write API and is refused even with a valid token.
 */
export const MCP_API_PREFIX = '/api/mcp/';
export const MCP_TOKEN_HEADER = 'x-vc-mcp-token';

export function isMcpApiPath(pathname: string): boolean {
	return pathname === '/api/mcp' || pathname.startsWith(MCP_API_PREFIX);
}

export type McpGateDecision =
	| { kind: 'not-mcp' }
	| { kind: 'allow' }
	| { kind: 'reject'; status: 401 | 403 | 503; code: 'MCP_API_DISABLED' | 'MCP_TOKEN_REQUIRED' | 'CROSS_SITE_BLOCKED' };

export interface McpGateInput {
	pathname: string;
	/** env.ts mcpToken(); undefined when the host never configured one. */
	token: string | undefined;
	/** `x-vc-mcp-token` header, null when absent. */
	headerToken: string | null;
	/** `Origin` header, null when absent. */
	origin: string | null;
}

export function decideMcpGate(input: McpGateInput): McpGateDecision {
	if (!isMcpApiPath(input.pathname)) return { kind: 'not-mcp' };
	if (!input.token) return { kind: 'reject', status: 503, code: 'MCP_API_DISABLED' };
	if (input.origin !== null) return { kind: 'reject', status: 403, code: 'CROSS_SITE_BLOCKED' };
	if (input.headerToken === null || !timingSafeEqualString(input.headerToken, input.token)) {
		return { kind: 'reject', status: 401, code: 'MCP_TOKEN_REQUIRED' };
	}
	return { kind: 'allow' };
}
