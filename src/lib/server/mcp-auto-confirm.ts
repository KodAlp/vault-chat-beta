import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { stagingDir } from './library';
import { AppError, errorPayload } from './app-error';
import { logAppEvent } from './app-log';
import { confirmStagedImport, type ConfirmIndexer } from './import-confirm';
import { readMeta, updateMeta } from './pending-imports';
import { getVaultMcpAutoConfirm, type VaultContext } from './vaults';
import { shouldAutoConfirm, type AutoConfirmMode } from '../mcp-auto-confirm-policy';

/**
 * The app confirming an MCP import on the user's standing per-vault setting
 * (vaults.ts getVaultMcpAutoConfirm). Called by startDetachedImport when a
 * conversion reaches `ready`. The MCP client still never confirms anything: it
 * only learns the outcome afterwards (listRecentlyConfirmed, surfaced by the
 * MCP list route) and can never change the setting.
 *
 * What the setting does NOT bypass: SSRF/robots/size checks, the import-path
 * allowlist and vault exposure all run before staging (mcp-import.ts,
 * stage-url.ts, api/mcp/imports) — auto-confirm only replaces the final click.
 */

/** Warning code left in the sidecar when the app tried and failed, so the pending list shows why the item is still waiting. */
export const AUTO_CONFIRM_FAILED = 'IMPORT_AUTO_CONFIRM_FAILED';

const RECENT_FILE = 'auto-confirmed.json';
/** Outcomes are only a courtesy for a polling agent: a day, and a short list, is plenty. */
export const RECENT_TTL_MS = 24 * 60 * 60 * 1000;
export const RECENT_MAX = 20;

export interface ConfirmedImport {
	importId: string;
	title: string;
	/** Library-relative path of the note. */
	path: string;
	confirmedAt: string;
}

function recentPath(v: VaultContext): string {
	// Not `<uuid>.json`, so pending-imports.ts's staging scan never mistakes it for a sidecar.
	return path.join(stagingDir(v), RECENT_FILE);
}

function readRecentRaw(v: VaultContext): ConfirmedImport[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(recentPath(v), 'utf-8'));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(e): e is ConfirmedImport =>
				typeof e === 'object' &&
				e !== null &&
				typeof (e as ConfirmedImport).importId === 'string' &&
				typeof (e as ConfirmedImport).title === 'string' &&
				typeof (e as ConfirmedImport).path === 'string' &&
				typeof (e as ConfirmedImport).confirmedAt === 'string'
		);
	} catch {
		return [];
	}
}

/** Auto-confirmed imports from the last day, newest first. */
export function listRecentlyConfirmed(v: VaultContext, now = Date.now()): ConfirmedImport[] {
	return readRecentRaw(v)
		.filter((e) => now - Date.parse(e.confirmedAt) < RECENT_TTL_MS)
		.sort((a, b) => (a.confirmedAt < b.confirmedAt ? 1 : -1))
		.slice(0, RECENT_MAX);
}

function recordConfirmed(v: VaultContext, entry: ConfirmedImport): void {
	const next = listRecentlyConfirmed(v).filter((e) => e.importId !== entry.importId);
	next.unshift(entry);
	const p = recentPath(v);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const tmp = `${p}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(next.slice(0, RECENT_MAX), null, 1) + '\n', 'utf-8');
	fs.renameSync(tmp, p);
}

function stagedNeedsReview(v: VaultContext, importId: string): boolean {
	try {
		return matter(fs.readFileSync(path.join(stagingDir(v), `${importId}.md`), 'utf-8')).data.needs_review === true;
	} catch {
		return false;
	}
}

export type AutoConfirmOutcome =
	| { kind: 'skipped'; mode: AutoConfirmMode }
	| { kind: 'confirmed'; path: string }
	| { kind: 'failed'; code: string };

/**
 * Applies the vault's mode to one `ready` import. Never throws: a failure
 * (e.g. the index is unreachable, so confirmStagedImport rolled everything
 * back) leaves the note pending and adds IMPORT_AUTO_CONFIRM_FAILED to its
 * warnings, so list_pending_imports and the app both show why it is waiting.
 */
export async function autoConfirmIfEligible(
	v: VaultContext,
	importId: string,
	deps: { mode?: AutoConfirmMode; indexer?: ConfirmIndexer } = {}
): Promise<AutoConfirmOutcome> {
	const mode = deps.mode ?? getVaultMcpAutoConfirm(v.id);
	const meta = readMeta(v, importId);
	if (!meta || mode === 'off') return { kind: 'skipped', mode };
	const eligible = shouldAutoConfirm(mode, { ...meta, needsReview: stagedNeedsReview(v, importId) });
	if (!eligible) return { kind: 'skipped', mode };

	try {
		const { path: relPath } = await confirmStagedImport(
			v,
			importId,
			{ title: meta.proposed.title, domain: meta.proposed.domain, level: meta.proposed.level, autoConfirmed: true },
			{ indexer: deps.indexer }
		);
		recordConfirmed(v, { importId, title: meta.proposed.title, path: relPath, confirmedAt: new Date().toISOString() });
		return { kind: 'confirmed', path: relPath };
	} catch (err) {
		// Code only in the app log — never a path, URL or title.
		const code = err instanceof AppError ? err.code : errorPayload(err).code;
		logAppEvent({ kind: 'fatal_error', message: `mcp auto-confirm failed: ${code}` });
		const current = readMeta(v, importId);
		if (current && !current.warnings.includes(AUTO_CONFIRM_FAILED)) {
			updateMeta(v, importId, { warnings: [...current.warnings, AUTO_CONFIRM_FAILED] });
		}
		return { kind: 'failed', code };
	}
}
