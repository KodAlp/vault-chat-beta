import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './env';
import { AppError } from './app-error';

/**
 * DATA_DIR/av-settings.json — the user's antivirus-scan preference for imports.
 * `avScan` is ON unless the user turned it off; a missing or corrupt file reads as ON (fail safe).
 * Exposed through GET/PUT /api/settings/av-scan (session-gated, like /api/settings/mcp).
 */
export interface AvSettings {
	avScan: boolean;
}

const FILE_NAME = 'av-settings.json';

function filePath(): string {
	return path.join(dataDir(), FILE_NAME);
}

export function readAvSettings(): AvSettings {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf-8')) as { avScan?: unknown };
		// Strictly `false` turns it off: anything else (missing, "false", 0) keeps scanning on.
		return { avScan: parsed.avScan !== false };
	} catch {
		return { avScan: true };
	}
}

/** Atomic write, same as mcp-settings.ts. */
export function writeAvSettings(patch: { avScan?: unknown }): AvSettings {
	const current = readAvSettings();
	if (patch.avScan !== undefined && typeof patch.avScan !== 'boolean') {
		throw new AppError('VALIDATION_INVALID', { field: 'avScan' });
	}
	const next: AvSettings = { avScan: patch.avScan === undefined ? current.avScan : patch.avScan };
	const p = filePath();
	const tmp = `${p}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
	fs.renameSync(tmp, p);
	return next;
}
