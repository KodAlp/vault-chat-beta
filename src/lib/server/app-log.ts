import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './env';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * data/app-log.jsonl — same content rule as mcp/log.ts: callers pass only
 * metadata (chat id, provider, model, error message) — never message
 * bodies, prompts, or chunk text. This is what survives a closed tab so a
 * broken run (a poisoned chats.db, a dead provider) leaves a trail instead
 * of just a silently dropped SSE stream. appendFileSync is deliberate: a
 * crash mid-write must not lose the record that would explain it.
 */
export interface AppLogRecord {
	ts: string;
	kind: 'chat_error' | 'fallback' | 'title_error' | 'db_error' | 'provider_error';
	chatId?: string;
	provider?: string;
	model?: string;
	message: string;
}

function logPath(): string {
	return path.join(dataDir(), 'app-log.jsonl');
}

function rotateIfNeeded(p: string): void {
	try {
		const stat = fs.statSync(p);
		if (stat.size > MAX_BYTES) fs.renameSync(p, `${p}.1`);
	} catch {
		// file doesn't exist yet — nothing to rotate
	}
}

/** Never throws — a logging failure must never break the caller's real work. */
export function logAppEvent(record: Omit<AppLogRecord, 'ts'>): void {
	try {
		const p = logPath();
		rotateIfNeeded(p);
		fs.appendFileSync(p, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, 'utf-8');
	} catch {
		// swallowed — see doc comment above
	}
}
