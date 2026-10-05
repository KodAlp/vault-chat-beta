import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { stagingDir } from './library';
import type { VaultContext } from './vaults';

/**
 * The "pending imports" list: everything sitting in a vault's staging area
 * waiting for the user's confirm/cancel (POST /api/library/import/[id]/…).
 *
 * Staging is `_meta/staging/<importId>.md` (the converted note). A browser
 * upload produces only that file and answers over its own SSE stream, so
 * nothing else needs to know about it. MCP imports run detached from the HTTP
 * request (the agent gets an importId back immediately and polls), so their
 * progress has to live somewhere other than a stream: a sidecar
 * `<importId>.json` next to the .md — queued → converting → ready | error.
 * The .json is removed by cancel and by a successful confirm.
 *
 * A .md with no .json (every browser upload, or a stale file from before this
 * existed) is listed as an "orphan": status 'ready', by 'app', title from its
 * frontmatter — it IS pending a decision, it just has no history.
 */
export type PendingStatus = 'queued' | 'converting' | 'ready' | 'error';

export interface PendingImportMeta {
	importId: string;
	status: PendingStatus;
	/** `name` is a display label only (file base name or URL host) — never a full local path. */
	source: { kind: 'path' | 'url'; name: string };
	proposed: { title: string; domain: string; level: string };
	warnings: string[];
	error?: { code: string; params?: Record<string, string | number> };
	by: 'mcp' | 'app';
	createdAt: string;
	updatedAt: string;
}

/** Same shape check the confirm route applies to params.id — a staging id is
 * always a crypto.randomUUID(), and anything else must never reach a path.join. */
export const IMPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGING_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(md|json)$/i;

const STATUSES = new Set<string>(['queued', 'converting', 'ready', 'error']);

/** Imports whose conversion is running in THIS process. A meta that says
 * queued/converting but is not in here was left behind by a process that
 * died (app closed mid-conversion) — listPending reports it as an error
 * instead of letting a polling agent wait for it forever. */
const active = new Set<string>();
export function markImportActive(importId: string): void {
	active.add(importId);
}
export function markImportInactive(importId: string): void {
	active.delete(importId);
}
/** How many conversions are running in this process — the MCP import route caps it. */
export function activeImportCount(): number {
	return active.size;
}

export function metaPath(v: VaultContext, importId: string): string {
	return path.join(stagingDir(v), `${importId}.json`);
}

/** Atomic (tmp + rename): a poller reading while the converter updates the
 * status must see either the old or the new file, never half of one. */
export function writeMeta(v: VaultContext, meta: PendingImportMeta): void {
	if (!IMPORT_ID_RE.test(meta.importId)) throw new Error('invalid importId');
	const p = metaPath(v, meta.importId);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const tmp = `${p}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
	fs.renameSync(tmp, p);
}

function isMeta(x: unknown): x is PendingImportMeta {
	if (typeof x !== 'object' || x === null) return false;
	const m = x as Partial<PendingImportMeta>;
	return (
		typeof m.importId === 'string' &&
		typeof m.status === 'string' &&
		STATUSES.has(m.status) &&
		typeof m.source === 'object' &&
		m.source !== null &&
		typeof m.proposed === 'object' &&
		m.proposed !== null &&
		Array.isArray(m.warnings) &&
		(m.by === 'mcp' || m.by === 'app')
	);
}

/** Missing, corrupt or wrongly-shaped sidecar reads as null. */
export function readMeta(v: VaultContext, importId: string): PendingImportMeta | null {
	if (!IMPORT_ID_RE.test(importId)) return null;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(metaPath(v, importId), 'utf-8'));
		return isMeta(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Merge-update helper for the converter: reads the current meta, applies the
 * patch, bumps updatedAt. A vanished meta (the user cancelled meanwhile) is
 * NOT resurrected — returns null and writes nothing. */
export function updateMeta(v: VaultContext, importId: string, patch: Partial<Omit<PendingImportMeta, 'importId' | 'createdAt'>>): PendingImportMeta | null {
	const current = readMeta(v, importId);
	if (!current) return null;
	const next: PendingImportMeta = { ...current, ...patch, importId, updatedAt: new Date().toISOString() };
	writeMeta(v, next);
	return next;
}

export function deleteMeta(v: VaultContext, importId: string): void {
	if (!IMPORT_ID_RE.test(importId)) return;
	fs.rmSync(metaPath(v, importId), { force: true });
}

function orphanFromMarkdown(v: VaultContext, importId: string): PendingImportMeta | null {
	const mdPath = path.join(stagingDir(v), `${importId}.md`);
	try {
		const stat = fs.statSync(mdPath);
		const fm = matter(fs.readFileSync(mdPath, 'utf-8')).data as Record<string, unknown>;
		const str = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
		const sourceUrl = str(fm.source_url);
		let host: string | undefined;
		if (sourceUrl) {
			try {
				host = new URL(sourceUrl).hostname;
			} catch {
				host = undefined;
			}
		}
		const created = stat.mtime.toISOString();
		return {
			importId,
			status: 'ready',
			source: { kind: sourceUrl ? 'url' : 'path', name: host ?? str(fm.source_file) ?? str(fm.title) ?? 'Adsız' },
			proposed: { title: str(fm.title) ?? 'Adsız', domain: str(fm.domain) ?? 'genel', level: str(fm.level) ?? 'undergraduate' },
			warnings: [],
			by: 'app',
			createdAt: created,
			updatedAt: created
		};
	} catch {
		return null;
	}
}

/** Every pending import in the vault's staging area, newest first. */
export function listPending(v: VaultContext): PendingImportMeta[] {
	const dir = stagingDir(v);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const ids = new Set<string>();
	for (const name of names) {
		const m = STAGING_FILE_RE.exec(name);
		if (m) ids.add(m[1]);
	}

	const out: PendingImportMeta[] = [];
	for (const id of ids) {
		const hasMd = fs.existsSync(path.join(dir, `${id}.md`));
		let meta = readMeta(v, id);
		if (meta && (meta.status === 'queued' || meta.status === 'converting') && !active.has(id)) {
			meta = { ...meta, status: 'error', error: { code: 'IMPORT_INTERRUPTED' } };
		}
		if (!meta && hasMd) meta = orphanFromMarkdown(v, id);
		// A sidecar claiming 'ready' whose note is gone has nothing left to confirm.
		if (meta && meta.status === 'ready' && !hasMd) meta = null;
		if (meta) out.push(meta);
	}
	return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
