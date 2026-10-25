import fs from 'node:fs';
import { providerConsentPath } from './env';

/**
 * 2026-09-23: which providers the user has explicitly
 * consented to send chat data to — the model picker's first-use prompt
 * writes here, and chat-fallback.ts's isProviderConsented dependency reads
 * it before ever routing a request (base chain AND a pin) to a provider.
 * Ollama is never stored here at all — isProviderConsented() below treats
 * it as always-consented (local, nothing leaves the device), so this file
 * only ever lists cloud provider ids the user actually said yes to.
 *
 * Same tmp+rename-with-retry shape as vaults.ts/config-store.ts — Windows
 * can transiently EPERM/EBUSY a rename right after a write, and this file
 * is written on every "remember my choice" click, same instant-PATCH
 * pattern as the rest of the settings UI.
 */
const RENAME_ATTEMPTS = 4;
const RENAME_BACKOFF_MS = 25;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface ConsentFile {
	consented: string[];
}

function readFile(): ConsentFile {
	try {
		const raw = fs.readFileSync(providerConsentPath(), 'utf-8');
		const parsed = JSON.parse(raw) as Partial<ConsentFile>;
		return { consented: Array.isArray(parsed.consented) ? parsed.consented : [] };
	} catch {
		// Missing/corrupt file — same "never lock the user out" lesson as
		// vaults.ts's readRegistry: an empty consent set is the safe default
		// (nothing is silently trusted), never a crash.
		return { consented: [] };
	}
}

function writeFile(data: ConsentFile): void {
	const p = providerConsentPath();
	const tmp = `${p}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');

	for (let attempt = 1; ; attempt++) {
		try {
			fs.renameSync(tmp, p);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
			if (!transient || attempt === RENAME_ATTEMPTS) {
				try {
					fs.rmSync(tmp, { force: true });
				} catch {
					// Nothing useful to do — do not mask the real failure below.
				}
				throw err;
			}
			sleepSync(RENAME_BACKOFF_MS * attempt);
		}
	}
}

/** True for Ollama by convention (see the module doc comment) — callers
 * that already know a provider is local should just skip this module
 * entirely rather than pass its id in; this only ever reflects what a real
 * "remember my choice" click wrote for a CLOUD provider. */
export function isProviderConsented(providerId: string): boolean {
	return readFile().consented.includes(providerId);
}

export function grantProviderConsent(providerId: string): void {
	const file = readFile();
	if (!file.consented.includes(providerId)) {
		file.consented.push(providerId);
		writeFile(file);
	}
}

export function revokeProviderConsent(providerId: string): void {
	const file = readFile();
	const next = file.consented.filter((id) => id !== providerId);
	if (next.length !== file.consented.length) {
		writeFile({ consented: next });
	}
}

export function listConsentedProviders(): string[] {
	return readFile().consented;
}
