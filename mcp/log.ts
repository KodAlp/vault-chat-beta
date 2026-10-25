import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../src/lib/server/env';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * data/mcp-log.jsonl — content rule ("içerik loglanmaz"):
 * Callers pass only metadata (path,
 * character counts, filter values) — never note bodies, chunk text,
 * frontmatter values, or the raw query string. appendFileSync is
 * deliberate: handlers are already serialized (vault-scope.ts's mutex),
 * writes are tiny, and a crash mid-write must not lose the record that
 * would explain it.
 */
export interface LogRecord {
	ts: string;
	tool: string;
	vault: string | null;
	ok: boolean;
	ms: number;
	resultCount?: number;
	errorCode?: string;
	params: Record<string, unknown>;
}

function logPath(): string {
	return path.join(dataDir(), 'mcp-log.jsonl');
}

function rotateIfNeeded(p: string): void {
	try {
		const stat = fs.statSync(p);
		if (stat.size > MAX_BYTES) fs.renameSync(p, `${p}.1`);
	} catch {
		// file doesn't exist yet — nothing to rotate
	}
}

/** Never throws — a logging failure must never break a tool call. */
export function logCall(record: LogRecord): void {
	try {
		const p = logPath();
		rotateIfNeeded(p);
		fs.appendFileSync(p, `${JSON.stringify(record)}\n`, 'utf-8');
	} catch {
		// swallowed — see doc comment above
	}
}
