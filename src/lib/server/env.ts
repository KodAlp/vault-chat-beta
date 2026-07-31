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
 * DATA_DIR/OLLAMA_URL were the first two migrated here (Faz 10's MCP path).
 * Faz 11 adds CHATS_DB_PATH/SKILLS_DIR/PROVIDERS_PATH/SECRETS_PATH — not
 * because MCP needs them, but because their old per-module defaults
 * (`path.join('data', '...')`, cwd-relative) silently diverged from
 * dataDir()'s DATA_DIR-aware resolution: with DATA_DIR set and no explicit
 * override for one of these four, chats.db/skills/providers.json/
 * secrets.json would land in a different directory than vaults.json. Every
 * default below is dataDir()-relative now, so DATA_DIR moves all of it
 * together. An explicit env var still wins over the default either way.
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

export function chatsDbPath(): string {
	return nonEmpty(process.env.CHATS_DB_PATH) ?? path.join(dataDir(), 'chats.db');
}

export function skillsDir(): string {
	return nonEmpty(process.env.SKILLS_DIR) ?? path.join(dataDir(), 'skills');
}

export function providersPath(): string {
	return nonEmpty(process.env.PROVIDERS_PATH) ?? path.join(dataDir(), 'providers.json');
}

export function secretsPath(): string {
	return nonEmpty(process.env.SECRETS_PATH) ?? path.join(dataDir(), 'secrets.json');
}
