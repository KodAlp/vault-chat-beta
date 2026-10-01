import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { secretsPath, secretsKeyHex, secretsProtection } from '../env';
import { AppError } from '../app-error';

/** What the settings UI is told about how API keys are held on this machine. */
export type SecretsMode = 'encrypted' | 'plaintext' | 'locked';

export interface SecretStore {
	/** Current protection level. Evaluated on demand (not cached) because the
	 * plaintext store flips to 'locked' if it finds an encrypted file on disk. */
	mode(): SecretsMode;
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

/** Thrown (HTTP 423) by every operation of a store that must not touch the file. */
function secretsLocked(): AppError {
	return new AppError('SECRETS_LOCKED', undefined, 423);
}

function readRawText(): string | null {
	try {
		return fs.readFileSync(secretsPath(), 'utf-8');
	} catch {
		return null;
	}
}

/** True when the file on disk is (or, if damaged, evidently was meant to be)
 * in the encrypted format. A plaintext store must never parse or overwrite
 * one — that would destroy the user's saved API keys. */
function textLooksEncrypted(text: string | null): boolean {
	if (text === null) return false;
	try {
		const parsed = JSON.parse(text) as RawSecretsFile;
		return typeof parsed === 'object' && parsed !== null && isEncryptedFile(parsed);
	} catch {
		// Truncated/damaged JSON: still refuse if it carries the envelope's marker.
		return /"encrypted"\s*:\s*true/.test(text);
	}
}

function readRawFile(): RawSecretsFile {
	const text = readRawText();
	if (text === null) return {};
	try {
		return JSON.parse(text) as RawSecretsFile;
	} catch {
		return {};
	}
}

function writeRawFile(data: RawSecretsFile): void {
	const p = secretsPath();
	fs.mkdirSync(path.dirname(p), { recursive: true });
	// mode: 0o600 (owner read/write only) only applies when the file is
	// CREATED, so POSIX also gets an explicit chmod on every write — an older
	// or externally-created file (or a changed umask) would otherwise keep
	// group/world-readable bits on raw API keys (or, once encrypted, the
	// ciphertext). Both are no-ops on Windows (no POSIX permission bits).
	fs.writeFileSync(p, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
	if (process.platform !== 'win32') fs.chmodSync(p, 0o600);
}

/**
 * data/secrets.json, server-only, gitignored. Keys never reach the client —
 * no endpoint in this layer returns a raw value; callers that need to show
 * status use maskKey() instead. Interface exists separately from the
 * implementations below so a later build can swap in something else again
 * without touching any caller.
 *
 * Plaintext store — used when no key is configured (plain dev server, no
 * Tauri involved at all) or when the desktop shell reports
 * SECRETS_PROTECTION=unavailable (no OS key storage exists on this system,
 * e.g. a Linux desktop without a Secret Service daemon). See
 * EncryptedSecretStore below for the normal desktop-app path.
 *
 * SAFETY: it never reads, interprets or overwrites a file in the encrypted
 * format — every operation throws SECRETS_LOCKED instead (e.g. the OS key
 * store disappeared after secrets were already encrypted).
 */
/** Exported for secrets.test.ts — the module-level `secretStore` singleton
 * below is fixed at import time (created once from whatever
 * SECRETS_PROTECTION/SECRETS_KEY_HEX/SECRETS_PATH happen to be set then), so
 * tests construct these directly instead of fighting that timing. */
export class JsonSecretStore implements SecretStore {
	mode(): SecretsMode {
		return textLooksEncrypted(readRawText()) ? 'locked' : 'plaintext';
	}

	private readAll(): Record<string, string> {
		if (textLooksEncrypted(readRawText())) throw secretsLocked();
		return readRawFile() as Record<string, string>;
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
 * AES-256-GCM over the whole provider-id -> key map. The key comes from the
 * desktop shell (src-tauri/src/secrets_key.rs: Windows DPAPI blob, macOS
 * Keychain, Linux Secret Service), passed through env.ts's secretsKeyHex() —
 * see its doc comment for why an env var is the only channel available.
 * Encrypts the map as one JSON blob per write (this file is small; per-key
 * encryption would only add complexity with no real benefit here).
 *
 * Transparently migrates a pre-existing plaintext secrets.json (this app's
 * only format before this class existed) the first time it's read: returns
 * the values normally, then immediately re-writes them in the encrypted
 * format — the migration is one-time and automatic, not something the user
 * has to trigger.
 */
export class EncryptedSecretStore implements SecretStore {
	constructor(private readonly key: Buffer) {}

	mode(): SecretsMode {
		return 'encrypted';
	}

	/** null = the file is encrypted but cannot be decrypted with this key. */
	private tryReadAll(): Record<string, string> | null {
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
			return null;
		}
	}

	/** Reads degrade to "no keys configured" on a wrong/rotated key or a
	 * corrupt file rather than throwing, matching the plaintext store's own
	 * missing-file behavior. */
	private readAll(): Record<string, string> {
		return this.tryReadAll() ?? {};
	}

	/** Writes must NOT degrade: replacing an undecryptable file with a fresh
	 * map would destroy the saved keys for good. */
	private readAllForWrite(): Record<string, string> {
		const all = this.tryReadAll();
		if (all === null) throw secretsLocked();
		return all;
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
		const all = this.readAllForWrite();
		all[providerId] = key;
		this.writeAll(all);
	}

	async delete(providerId: string): Promise<void> {
		const all = this.readAllForWrite();
		delete all[providerId];
		this.writeAll(all);
	}

	async list(): Promise<string[]> {
		return Object.keys(this.readAll());
	}
}

/**
 * SECRETS_PROTECTION=locked: the desktop shell knows an encryption key exists
 * (or may exist) but could not read it — corrupt DPAPI blob, keychain locked
 * or access denied. Refuses everything, so nothing is ever written in the
 * clear or over the existing encrypted file.
 */
export class LockedSecretStore implements SecretStore {
	mode(): SecretsMode {
		return 'locked';
	}
	async get(_providerId: string): Promise<string | null> {
		throw secretsLocked();
	}
	async set(_providerId: string, _key: string): Promise<void> {
		throw secretsLocked();
	}
	async delete(_providerId: string): Promise<void> {
		throw secretsLocked();
	}
	async list(): Promise<string[]> {
		throw secretsLocked();
	}
}

export interface SecretStoreSelection {
	/** SECRETS_PROTECTION: 'encrypted' | 'unavailable' | 'locked' (undefined when no desktop shell is involved). */
	protection: string | undefined;
	/** SECRETS_KEY_HEX */
	keyHex: string | undefined;
}

function keyFromHex(keyHex: string | undefined): Buffer | null {
	if (!keyHex) return null;
	const key = Buffer.from(keyHex, 'hex');
	return key.length === 32 ? key : null;
}

/** Exported for secrets.test.ts. Absent protection = plain dev server / tests:
 * a valid key means encrypted, otherwise plaintext. With a protection value
 * from the desktop shell, anything unexpected fails closed (locked). */
export function selectSecretStore({ protection, keyHex }: SecretStoreSelection): SecretStore {
	const key = keyFromHex(keyHex);
	switch (protection) {
		case undefined:
			return key ? new EncryptedSecretStore(key) : new JsonSecretStore();
		case 'encrypted':
			return key ? new EncryptedSecretStore(key) : new LockedSecretStore();
		case 'unavailable':
			return new JsonSecretStore();
		default:
			return new LockedSecretStore();
	}
}

export const secretStore: SecretStore = selectSecretStore({ protection: secretsProtection(), keyHex: secretsKeyHex() });

/** First 3 + last 4 chars — enough for a user to recognize which key is
 * stored without ever reconstituting the real value from the response. */
export function maskKey(key: string): string {
	if (key.length <= 7) return '…';
	return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
