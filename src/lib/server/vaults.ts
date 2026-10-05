import fs from 'node:fs';
import path from 'node:path';
import { foldToSlug } from './slug';
import { dataDir } from './env';
import { AppError } from './app-error';

export interface VaultRecord {
	id: string;
	name: string;
	path: string;
	createdAt: string;
	lastOpenedAt: string;
	/** Set by scripts/sync-vault.ts on a successful re-import + re-index —
	 * absent for a vault that has never been synced that way (imported once
	 * through the UI, say). Exists so the imported library copy can no
	 * longer silently go stale with nothing surfacing when it last matched
	 * the real Obsidian vault; see the vault-registry skill. */
	lastSyncedAt?: string;
	/** İ6 (Aşama 8, 2026-09-23): whether an external MCP client (Claude
	 * Desktop, Claude Code, any other MCP-speaking agent) can see and read
	 * this vault at all. Absent/false means closed — mcp/vault-scope.ts's
	 * withVault() rejects every tool call against a vault that isn't
	 * explicitly opened this way, and list-vaults.ts never lists it, so a
	 * closed vault is invisible to an external client, not just
	 * access-denied on request (a client that already knows or guesses an
	 * id, e.g. "default", must not be able to reach it either). */
	mcpExposed?: boolean;
	/** Set when an MCP client created the vault (create_vault -> POST /api/mcp/vaults) so the
	 * UI can mark it "created via MCP". Absent for every vault made in the app. */
	createdVia?: 'mcp';
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
	/** İ6 migration (Aşama 8, 2026-09-23): true once the user has answered
	 * the one-time "keep existing vaults open to MCP, or close them?"
	 * prompt — closed is the new field's default for every vault, which
	 * would silently break an MCP setup (Aşama 0) that already worked
	 * against every vault implicitly. Absent/false on a registry written
	 * before this field existed is exactly "needs asking"; a registry
	 * created fresh after this field existed has nothing to migrate, so
	 * createVault() below stamps it true immediately, never showing the
	 * prompt for a vault that was never open to begin with. */
	mcpMigrationAsked?: boolean;
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
			activeVaultId: parsed.activeVaultId ?? null,
			mcpMigrationAsked: parsed.mcpMigrationAsked ?? false
		};
	} catch {
		// A fresh array every call — never share one mutable array across
		// callers. A shared `EMPTY_REGISTRY.vaults` reference here previously
		// caused createVault()'s `reg.vaults.push()` to permanently mutate a
		// module-level array, leaking entries into every later "missing
		// registry" read regardless of which directory was being read from.
		return { vaults: [], activeVaultId: null, mcpMigrationAsked: false };
	}
}

/**
 * Atomic write: temp file + rename, so a crash mid-write never leaves a
 * half-written vaults.json for the next readRegistry() to choke on.
 *
 * The rename is retried because on Windows it is not reliably atomic in
 * practice: if anything holds the destination open for an instant — an
 * antivirus scanner or the Search indexer noticing the file we just wrote —
 * the call fails with EPERM/EBUSY even though nothing is wrong. A real
 * instance is in app-log.jsonl ("setActiveVault/touchVault failed for
 * default: EPERM ... rename 'vaults.json.9288.tmp' -> 'vaults.json'"). Those
 * locks are transient, so a couple of short retries clear them; the same
 * class of Windows rename failure is already documented in library.ts.
 *
 * The temp file is removed when every attempt fails — without that, each
 * failure left a stray vaults.json.<pid>.tmp in data/.
 */
const RENAME_ATTEMPTS = 4;
const RENAME_BACKOFF_MS = 25;

function writeRegistry(reg: RegistryFile): void {
	const p = registryPath();
	const tmp = `${p}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf-8');

	for (let attempt = 1; ; attempt++) {
		try {
			fs.renameSync(tmp, p);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
			if (!transient || attempt === RENAME_ATTEMPTS) {
				// Best-effort cleanup; the original error is what the caller needs.
				try {
					fs.rmSync(tmp, { force: true });
				} catch {
					// Nothing useful to do — do not mask the real failure below.
				}
				throw err;
			}
			// Synchronous by design: writeRegistry is called from sync code
			// paths (page loads, API handlers) that cannot await, and the wait
			// is tens of milliseconds at most.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_BACKOFF_MS * attempt);
		}
	}
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
		throw new AppError('NOT_FOUND', { entity: 'vault', detail: id }, 404);
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
	if (!trimmed) throw new AppError('VAULT_NAME_EMPTY');

	const reg = readRegistry();
	// İ6: a vault created into a genuinely empty registry never had implicit
	// MCP access to lose — nothing to migrate, so the one-time prompt is
	// pre-answered rather than surfacing for a setup that's brand new.
	const isFirstVaultEver = reg.vaults.length === 0;
	const id = uniqueId(reg, trimmed);
	const now = new Date().toISOString();
	const record: VaultRecord = {
		id,
		name: trimmed,
		path: path.join(vaultsRoot(), id, 'library'),
		createdAt: now,
		lastOpenedAt: now,
		mcpExposed: false
	};

	fs.mkdirSync(contextFor(record).libraryRoot, { recursive: true });

	reg.vaults.push(record);
	if (!reg.activeVaultId) reg.activeVaultId = id;
	if (isFirstVaultEver) reg.mcpMigrationAsked = true;
	writeRegistry(reg);
	return record;
}

/** create_vault: an ordinary createVault() that is also opened to MCP (the client that made it must be
 * able to use it) and stamped `createdVia: 'mcp'`. Both fields are written in one registry write. */
export function createVaultViaMcp(name: string): VaultRecord {
	const created = createVault(name);
	const reg = readRegistry();
	const record = reg.vaults.find((v) => v.id === created.id);
	if (!record) throw new AppError('NOT_FOUND', { entity: 'vault', detail: created.id }, 404);
	record.mcpExposed = true;
	record.createdVia = 'mcp';
	writeRegistry(reg);
	return record;
}

export function renameVault(id: string, name: string): VaultRecord {
	const trimmed = name.trim();
	if (!trimmed) throw new AppError('VAULT_NAME_EMPTY');

	const reg = readRegistry();
	const record = reg.vaults.find((v) => v.id === id);
	if (!record) throw new AppError('NOT_FOUND', { entity: 'vault', detail: id }, 404);
	record.name = trimmed;
	writeRegistry(reg);
	return record;
}

/** İ6: per-vault MCP exposure toggle. */
export function setVaultMcpExposed(id: string, exposed: boolean): VaultRecord {
	const reg = readRegistry();
	const record = reg.vaults.find((v) => v.id === id);
	if (!record) throw new AppError('NOT_FOUND', { entity: 'vault', detail: id }, 404);
	record.mcpExposed = exposed;
	writeRegistry(reg);
	return record;
}

export function isVaultMcpExposed(id: string): boolean {
	return listVaults().find((v) => v.id === id)?.mcpExposed === true;
}

/** True when there are pre-existing vaults from before İ6 shipped whose
 * exposure the user hasn't been asked about yet — see RegistryFile's
 * mcpMigrationAsked doc comment for why this can't just default silently. */
export function needsMcpMigrationPrompt(): boolean {
	const reg = readRegistry();
	return !reg.mcpMigrationAsked && reg.vaults.length > 0;
}

/** Answers the one-time migration prompt. exposeAll=true keeps every
 * existing vault reachable over MCP exactly as it was (implicitly, before
 * this gate existed) — exposeAll=false adopts the new closed-by-default
 * posture for all of them. Either way, mcpMigrationAsked flips permanently
 * so this never asks again. */
export function resolveMcpMigration(exposeAll: boolean): void {
	const reg = readRegistry();
	if (exposeAll) {
		for (const v of reg.vaults) v.mcpExposed = true;
	}
	reg.mcpMigrationAsked = true;
	writeRegistry(reg);
}

export function touchVault(id: string): void {
	const reg = readRegistry();
	const record = reg.vaults.find((v) => v.id === id);
	if (!record) return;
	record.lastOpenedAt = new Date().toISOString();
	writeRegistry(reg);
}

/** Called by scripts/sync-vault.ts after a successful re-import + re-index —
 * same read/write shape as touchVault, distinct field. Throws on an unknown
 * id (unlike touchVault) since a CLI script should fail loudly on a typoed
 * --vault, not silently no-op. */
export function markVaultSynced(id: string): void {
	const reg = readRegistry();
	const record = reg.vaults.find((v) => v.id === id);
	if (!record) throw new AppError('NOT_FOUND', { entity: 'vault', detail: id }, 404);
	record.lastSyncedAt = new Date().toISOString();
	writeRegistry(reg);
}

/**
 * "This vault is the one being used right now" — sets activeVaultId and
 * lastOpenedAt in a SINGLE read+write.
 *
 * Opening a vault or one of its chats is one logical event, but it used to
 * call setActiveVault() then touchVault(), each doing its own read, write and
 * rename. That is two chances per page load to hit the transient Windows
 * rename lock described on writeRegistry, for no benefit. setActiveVault
 * stays exported because /api/vaults/[id]/activate genuinely only wants the
 * active-vault half.
 */
export function markVaultUsed(id: string): void {
	const reg = readRegistry();
	const record = reg.vaults.find((v) => v.id === id);
	if (!record) throw new AppError('NOT_FOUND', { entity: 'vault', detail: id }, 404);
	reg.activeVaultId = id;
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
	if (!record) throw new AppError('NOT_FOUND', { entity: 'vault', detail: id }, 404);
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
	if (!record) throw new AppError('NOT_FOUND', { entity: 'vault', detail: id }, 404);

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
		throw new AppError('VAULT_NONE');
	}
	const record = listVaults().find((v) => v.id === targetId);
	if (!record) {
		throw new AppError('NOT_FOUND', { entity: 'vault', detail: targetId }, 404);
	}
	return contextFor(record);
}

/** True once migration has run (or a fresh install created its first
 * vault) — used by server startup to decide whether to auto-run migration. */
export function hasAnyVault(): boolean {
	return listVaults().length > 0;
}
