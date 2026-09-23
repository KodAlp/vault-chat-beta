/**
 * Tool-level errors are returned as { isError: true }, never thrown — a
 * thrown exception aborts the calling agent's whole turn, while a typed
 * error code is something it can read and act on. See the mcp-server
 * skill's "Araç tasarımı kuralları".
 */
export type ToolErrorCode =
	| 'VAULT_NOT_FOUND'
	| 'VAULT_NOT_EXPOSED'
	| 'NOT_INDEXED'
	| 'OLLAMA_UNAVAILABLE'
	| 'NOTE_NOT_FOUND'
	| 'PATH_OUTSIDE_LIBRARY';

export class ToolError extends Error {
	readonly code: ToolErrorCode;

	constructor(code: ToolErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/** Converts a caught error into the CallToolResult error shape. Anything
 * not already a ToolError is wrapped generically — a raw exception (e.g.
 * a resolveVault() throw, or the traversal guard's plain Error) still
 * becomes a returned error, never an uncaught rejection that could kill
 * the stdio server. */
export function toolErrorResult(err: unknown): { isError: true; content: [{ type: 'text'; text: string }] } {
	if (err instanceof ToolError) {
		return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}` }] };
	}
	const message = err instanceof Error ? err.message : String(err);
	return { isError: true, content: [{ type: 'text', text: `UNKNOWN_ERROR: ${message}` }] };
}
