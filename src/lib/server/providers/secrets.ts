import fs from 'node:fs';
import path from 'node:path';
import { secretsPath } from '../env';

export interface SecretStore {
	get(providerId: string): Promise<string | null>;
	set(providerId: string, key: string): Promise<void>;
	delete(providerId: string): Promise<void>;
	/** Provider ids only, never values. */
	list(): Promise<string[]>;
}

function readAll(): Record<string, string> {
	try {
		return JSON.parse(fs.readFileSync(secretsPath(), 'utf-8')) as Record<string, string>;
	} catch {
		return {};
	}
}

function writeAll(secrets: Record<string, string>): void {
	const p = secretsPath();
	fs.mkdirSync(path.dirname(p), { recursive: true });
	// mode: 0o600 (owner read/write only) — a no-op on Windows (no POSIX
	// permission bits), but this file also ships as part of the Tauri
	// desktop build's data dir on macOS/Linux (Phase 7, per this module's
	// own doc comment on the eventual OS-keychain migration), where the
	// default umask would otherwise leave raw API keys group/world-readable.
	fs.writeFileSync(p, JSON.stringify(secrets, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * data/secrets.json, server-only, gitignored. Keys never reach the client —
 * no endpoint in this layer returns a raw value; callers that need to show
 * status use maskKey() instead. Interface exists separately from this
 * implementation so a later (Phase 7 Tauri) build can swap in an OS
 * keychain and migrate this one file, per the skill doc.
 */
class JsonSecretStore implements SecretStore {
	async get(providerId: string): Promise<string | null> {
		return readAll()[providerId] ?? null;
	}

	async set(providerId: string, key: string): Promise<void> {
		const all = readAll();
		all[providerId] = key;
		writeAll(all);
	}

	async delete(providerId: string): Promise<void> {
		const all = readAll();
		delete all[providerId];
		writeAll(all);
	}

	async list(): Promise<string[]> {
		return Object.keys(readAll());
	}
}

export const secretStore: SecretStore = new JsonSecretStore();

/** First 3 + last 4 chars — enough for a user to recognize which key is
 * stored without ever reconstituting the real value from the response. */
export function maskKey(key: string): string {
	if (key.length <= 7) return '…';
	return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
