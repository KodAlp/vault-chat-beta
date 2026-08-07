import fs from 'node:fs';
import path from 'node:path';
import { foldToSlug } from './slug';
import { dataDir } from './env';

export interface VaultRecord {
	id: string;
	name: string;
	path: string;
	createdAt: string;
	lastOpenedAt: string;
}

export interface VaultContext {
	id: string;
	name: string;
	dir: string;
	libraryRoot: string;
	indexDbPath: string;
	studyDbPath: string;
}

interface RegistryFile {
	vaults: VaultRecord[];
	activeVaultId: string | null;
}

function registryPath(): string {
	return path.join(dataDir(), 'vaults.json');
}

export function vaultsRoot(): string {
	return path.join(dataDir(), 'vaults');
}

/**
 * Corrupt/missing registry is treated identically — never thrown as Err.
 * Same lesson as the Tauri config.json fix (Phase 7): a parse failure must
 * never permanently lock the app out with no recovery path. Callers that
 * need to distinguish "genuinely empty" from "broken" don't exist yet; if
 * one shows up, log here first.
 *
 * `path` is re-derived here rather than trusted from disk: it's a computed
 * value (vaultsRoot()/id/library), not user input, and vaultsRoot() is
 * cwd/DATA_DIR-relative — so whatever absolute string got persisted on a
 * different machine, user account, or checkout location is discarded on
 * every read in favor of what's correct for *this* run. Without this, a
 * vaults.json carried between machines (or surviving a Windows account
 * rename) would keep pointing at a path that no longer resolves anywhere.
 */
function readRegistry(): RegistryFile {
	try {
		const raw = fs.readFileSync(registryPath(), 'utf-8');
		const parsed = JSON.parse(raw) as Partial<RegistryFile>;
		const vaults = Array.isArray(parsed.vaults) ? parsed.vaults : [];
		return {
			vaults: vaults.map((v) => ({ ...v, path: contextFor(v).libraryRoot })),
			activeVaultId: parsed.activeVaultId ?? null
		};
	} catch {
		// A fresh array every call — never share one mutable array across
		// callers. A shared `EMPTY_REGISTRY.vaults` reference here previously
		// caused createVault()'s `reg.vaults.push()` to permanently mutate a
		// module-level array, leaking entries into every later "missing
		// registry" read regardless of which directory was being read from.
		return { vaults: [], activeVaultId: null };
	}
}

/** Atomic write: temp file + rename, so a crash mid-write never leaves a
 * half-written vaults.json for the next readRegistry() to choke on. */
function writeRegistry(reg: RegistryFile): void {
	const p = registryPath();
	const tmp = `${p}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf-8');
	fs.renameSync(tmp, p);
}

function uniqueId(reg: RegistryFile, name: string): string {
	const base = foldToSlug(name, 'vault');
	let candidate = base;
	let n = 2;
	while (reg.vaults.some((v) => v.id === candidate)) {
		candidate = `${base}-${n++}`;
	}
	return candidate;
}

export function contextFor(record: VaultRecord): VaultContext {
	const dir = path.join(vaultsRoot(), record.id);
	return {
		id: record.id,
		name: record.name,
		dir,
		libraryRoot: path.join(dir, 'library'),
		indexDbPath: path.join(dir, 'index.db'),
		studyDbPath: path.join(dir, 'study.db')
	};
}

export function listVaults(): VaultRecord[] {
	return readRegistry().vaults;
}

export function getActiveVaultId(): string | null {
	const reg = readRegistry();
	if (reg.activeVaultId && reg.vaults.some((v) => v.id === reg.activeVaultId)) {
		return reg.activeVaultId;
	}
	return reg.vaults[0]?.id ?? null;
}

export function setActiveVault(id: string): void {
	const reg = readRegistry();
	if (!reg.vaults.some((v) => v.id === id)) {
		throw new Error(`Bilinmeyen vault: ${id}`);
	}
	reg.activeVaultId = id;
	writeRegistry(reg);
}

/** Creates the vault's on-disk folders (library/ + _meta placeholders come
 * from library.ts on first write) and registers it. Does NOT create
 * index.db/study.db eagerly — those modules create their own DB file on
 * first open, same as the single-vault code did. */
export function createVault(name: string): VaultRecord {
	const trimmed = name.trim();
	if (!trimmed) throw new Error('Vault adı boş olamaz');

	const reg = readRegistry();
	const id = uniqueId(reg, trimmed);
	const now = new Date().toISOString();
	const record: VaultRecord = {
		id,
		name: trimmed,
		path: path.join(vaultsRoot(), id, 'library'),
		createdAt: now,
		lastOpenedAt: now
	};

	fs.mkdirSync(contextFor(record).libraryRoot, { recursive: true });

	reg.vaults.push(record);
	if (!reg.activeVaultId) reg.activeVaultId = id;
	writeRegistry(reg);
	return record;
}

export function renameVault(id: string, name: string): VaultRecord {
	const trimmed = name.trim();
	if (!trimmed) throw new Error('Vault adı boş olamaz');

	const reg = readRegistry();
	const record = reg.vaults.find((v) => v.id === id);
	if (!record) throw new Error(`Bilinmeyen vault: ${id}`);
	record.name = trimmed;
	writeRegistry(reg);
	return record;
}

export function touchVault(id: string): void {
	const reg = readRegistry();
	const record = reg.vaults.find((v) => v.id === id);
	if (!record) return;
	record.lastOpenedAt = new Date().toISOString();
	writeRegistry(reg);
}

/** Non-destructive preview for the confirm dialog — caller decides whether
 * to actually proceed to deleteVault(). Chat count is queried lazily via
 * the passed-in counter to avoid a hard dependency from vaults.ts on
 * chats-db.ts (registry stays a leaf module). */
export function describeVaultDeletion(
	id: string,
	countChats: (vaultId: string) => number
): { vault: VaultRecord; chatCount: number } {
	const record = listVaults().find((v) => v.id === id);
	if (!record) throw new Error(`Bilinmeyen vault: ${id}`);
	return { vault: record, chatCount: countChats(id) };
}

/**
 * Removes the vault's folder (library + index.db + study.db, all under
 * vaults/<id>/) and its registry entry. Two callers must run BEFORE this,
 * both kept out of this module for the leaf-module reason
 * describeVaultDeletion documents:
 *   1. api/vaults/[id] route deletes the vault's chats from chats.db first.
 *   2. That same route must also close retrieve.ts's and study-db.ts's
 *      cached better-sqlite3 connections for this vault id first — Windows
 *      refuses to delete/rename a file with an open handle (EBUSY), and
 *      those two modules cache one connection per vault for the process
 *      lifetime. Deleting files BEFORE updating the registry (not after,
 *      as an earlier version of this function did) means a failure here —
 *      e.g. a caller that forgot step 2 — leaves the vault fully intact
 *      and retryable instead of orphaned (registry entry gone, files stuck).
 */
export function deleteVault(id: string): void {
	const record = listVaults().find((v) => v.id === id);
	if (!record) throw new Error(`Bilinmeyen vault: ${id}`);

	fs.rmSync(contextFor(record).dir, { recursive: true, force: true });

	const reg = readRegistry();
	const idx = reg.vaults.findIndex((v) => v.id === id);
	if (idx !== -1) reg.vaults.splice(idx, 1);
	if (reg.activeVaultId === id) {
		reg.activeVaultId = reg.vaults[0]?.id ?? null;
	}
	writeRegistry(reg);
}

/** id undefined -> active vault. Throws on an unknown id so route handlers
 * can turn it into a 404 instead of silently operating on the wrong vault. */
export function resolveVault(id?: string | null): VaultContext {
	const targetId = id ?? getActiveVaultId();
	if (!targetId) {
		throw new Error('Hiç vault yok — önce bir vault oluştur');
	}
	const record = listVaults().find((v) => v.id === targetId);
	if (!record) {
		throw new Error(`Bilinmeyen vault: ${targetId}`);
	}
	return contextFor(record);
}

/** True once migration has run (or a fresh install created its first
 * vault) — used by server startup to decide whether to auto-run migration. */
export function hasAnyVault(): boolean {
	return listVaults().length > 0;
}
