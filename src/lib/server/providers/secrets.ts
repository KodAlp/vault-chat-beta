import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { secretsPath, secretsKeyHex } from '../env';

export interface SecretStore {
	get(providerId: string): Promise<string | null>;
	set(providerId: string, key: string): Promise<void>;
	delete(providerId: string): Promise<void>;
	/** Provider ids only, never values. */
	list(): Promise<string[]>;
}

interface EncryptedSecretsFile {
	encrypted: true;
	iv: string;
	tag: string;
	data: string;
}

type RawSecretsFile = Record<string, string> | EncryptedSecretsFile;

function isEncryptedFile(v: RawSecretsFile): v is EncryptedSecretsFile {
	return typeof v === 'object' && v !== null && (v as Partial<EncryptedSecretsFile>).encrypted === true;
}

function readRawFile(): RawSecretsFile {
	try {
		return JSON.parse(fs.readFileSync(secretsPath(), 'utf-8')) as RawSecretsFile;
	} catch {
		return {};
	}
}

function writeRawFile(data: RawSecretsFile): void {
	const p = secretsPath();
	fs.mkdirSync(path.dirname(p), { recursive: true });
	// mode: 0o600 (owner read/write only) — a no-op on Windows (no POSIX
	// permission bits), but this file also ships as part of the Tauri
	// desktop build's data dir on macOS/Linux, where the default umask
	// would otherwise leave raw API keys (or, once encrypted, the
	// ciphertext) group/world-readable.
	fs.writeFileSync(p, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * data/secrets.json, server-only, gitignored. Keys never reach the client —
 * no endpoint in this layer returns a raw value; callers that need to show
 * status use maskKey() instead. Interface exists separately from both
 * implementations below so a later build can swap in something else again
 * without touching any caller.
 *
 * Plaintext fallback — used whenever no SECRETS_KEY_HEX is available (plain
 * `npm run dev`, no Tauri involved at all; or a DPAPI setup failure on the
 * Tauri side). See DpapiEncryptedSecretStore below for the real desktop-app
 * path.
 */
/** Exported for secrets.test.ts — the module-level `secretStore` singleton
 * below is fixed at import time (created once from whatever
 * SECRETS_KEY_HEX/SECRETS_PATH happen to be set then), so tests construct
 * these directly instead of fighting that timing. */
export class JsonSecretStore implements SecretStore {
	private readAll(): Record<string, string> {
		const raw = readRawFile();
		return isEncryptedFile(raw) ? {} : raw;
	}

	async get(providerId: string): Promise<string | null> {
		return this.readAll()[providerId] ?? null;
	}

	async set(providerId: string, key: string): Promise<void> {
		const all = this.readAll();
		all[providerId] = key;
		writeRawFile(all);
	}

	async delete(providerId: string): Promise<void> {
		const all = this.readAll();
		delete all[providerId];
		writeRawFile(all);
	}

	async list(): Promise<string[]> {
		return Object.keys(this.readAll());
	}
}

const ALGORITHM = 'aes-256-gcm';

/**
 * Windows-only today: the key comes from spawn_sidecar()'s DPAPI setup
 * (src-tauri/src/lib.rs), passed through env.ts's secretsKeyHex() — see its
 * doc comment for why an env var is the only channel available. Encrypts
 * the whole provider-id -> key map as one JSON blob per write (this file is
 * small; per-key encryption would only add complexity with no real benefit
 * here).
 *
 * Transparently migrates a pre-existing plaintext secrets.json (this app's
 * only format before this class existed) the first time it's read: returns
 * the values normally, then immediately re-writes them in the encrypted
 * format — the migration is one-time and automatic, not something the user
 * has to trigger.
 */
export class DpapiEncryptedSecretStore implements SecretStore {
	constructor(private readonly key: Buffer) {}

	private readAll(): Record<string, string> {
		const raw = readRawFile();
		if (!isEncryptedFile(raw)) {
			if (Object.keys(raw).length > 0) this.writeAll(raw);
			return raw;
		}
		try {
			const iv = Buffer.from(raw.iv, 'base64');
			const tag = Buffer.from(raw.tag, 'base64');
			const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
			decipher.setAuthTag(tag);
			const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]);
			return JSON.parse(plain.toString('utf-8')) as Record<string, string>;
		} catch {
			// Wrong/rotated key (e.g. a different Windows profile, or the
			// DPAPI blob was deleted) or a corrupt file — degrade to "no keys
			// configured" rather than throwing, matching JsonSecretStore's
			// own missing-file behavior.
			return {};
		}
	}

	private writeAll(secrets: Record<string, string>): void {
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
		const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf-8'), cipher.final()]);
		const tag = cipher.getAuthTag();
		writeRawFile({
			encrypted: true,
			iv: iv.toString('base64'),
			tag: tag.toString('base64'),
			data: ciphertext.toString('base64')
		});
	}

	async get(providerId: string): Promise<string | null> {
		return this.readAll()[providerId] ?? null;
	}

	async set(providerId: string, key: string): Promise<void> {
		const all = this.readAll();
		all[providerId] = key;
		this.writeAll(all);
	}

	async delete(providerId: string): Promise<void> {
		const all = this.readAll();
		delete all[providerId];
		this.writeAll(all);
	}

	async list(): Promise<string[]> {
		return Object.keys(this.readAll());
	}
}

function createSecretStore(): SecretStore {
	const keyHex = secretsKeyHex();
	if (!keyHex) return new JsonSecretStore();
	const key = Buffer.from(keyHex, 'hex');
	if (key.length !== 32) return new JsonSecretStore();
	return new DpapiEncryptedSecretStore(key);
}

export const secretStore: SecretStore = createSecretStore();

/** First 3 + last 4 chars — enough for a user to recognize which key is
 * stored without ever reconstituting the real value from the response. */
export function maskKey(key: string): string {
	if (key.length <= 7) return '…';
	return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
