import path from 'node:path';
import fs from 'node:fs';

/**
 * process.env accessors for server modules that must run both inside
 * SvelteKit (where $env/dynamic/private normally reads these) and outside
 * it — the MCP server (mcp/), which runs via tsx with no Vite runtime at
 * all. $env/dynamic/private is a Vite virtual module and cannot resolve
 * there. See the mcp-server skill for the full rationale.
 *
 * Every accessor is a FUNCTION, not a module-level constant — this matches
 * $env/dynamic/private's actual semantics (dynamic, re-read on every
 * access) and avoids an ESM-hoisting trap: a bootstrap that sets
 * process.env.DATA_DIR and then does `await import('./server.ts')` would
 * otherwise lose to a constant this module captured at its own load time.
 *
 * Only the two variables Faz 10's MCP path actually touches
 * (DATA_DIR, OLLAMA_URL) are migrated here. CHATS_DB_PATH/SKILLS_DIR/
 * PROVIDERS_PATH/SECRETS_PATH stay on $env/dynamic/private in their
 * current modules — none of them are on the MCP read path, and migrating
 * them is a separate change with its own blast radius.
 */
function nonEmpty(v: string | undefined): string | undefined {
	return v && v.length > 0 ? v : undefined;
}

/** Moved from vaults.ts verbatim — same per-call resolution, same
 * mkdirSync side effect (directory creation, not a data write). Keeping
 * this behavior identical is what lets vaults.test.ts's useTmpDataDir()
 * keep working unchanged. */
export function dataDir(): string {
	const raw = nonEmpty(process.env.DATA_DIR);
	const root = raw ? path.resolve(process.cwd(), raw) : path.resolve(process.cwd(), 'data');
	fs.mkdirSync(root, { recursive: true });
	return root;
}

export function ollamaUrl(): string {
	return nonEmpty(process.env.OLLAMA_URL) ?? 'http://localhost:11434';
}
