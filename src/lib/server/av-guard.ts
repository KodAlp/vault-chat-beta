import { AppError } from './app-error';
import { logAppEvent } from './app-log';
import { scanFile, type AvScanResult } from './av-scan';
import { readAvSettings } from './av-settings';

/**
 * The import policy around av-scan.ts (TODO #60). Called once per file, right before conversion
 * (convertQueue.enqueueConversion), so every path that converts a user file is covered by one call.
 *
 *  - setting off              -> nothing happens
 *  - 'infected'               -> AppError FILE_THREAT_DETECTED (the import is rejected; nothing is quarantined or deleted)
 *  - 'unavailable'            -> import proceeds; ONE `av_unavailable` app-log line per process
 *  - 'error' (failed/timeout) -> import proceeds; `av_error` logged every time (DECISION: a broken scanner never blocks imports)
 */
export interface AvGuardDeps {
	scan: (path: string) => Promise<AvScanResult>;
	enabled: () => boolean;
	log: typeof logAppEvent;
}

let warnedUnavailable = false;
/** Test helper: forget that the one-time warning was already logged. */
export function resetAvGuardWarnings(): void {
	warnedUnavailable = false;
}

const defaultDeps: AvGuardDeps = {
	scan: (p) => scanFile(p),
	enabled: () => readAvSettings().avScan,
	log: logAppEvent
};

export async function assertFileClean(filePath: string, deps: Partial<AvGuardDeps> = {}): Promise<AvScanResult | null> {
	const d = { ...defaultDeps, ...deps };
	if (!d.enabled()) return null;
	const result = await d.scan(filePath);
	switch (result.status) {
		case 'infected':
			d.log({ kind: 'av_threat', message: `engine=${result.engine ?? '?'} threat=${result.threat ?? 'unknown'} ms=${result.ms}` });
			throw new AppError('FILE_THREAT_DETECTED', { threat: result.threat ?? 'unknown' }, 422);
		case 'unavailable':
			if (!warnedUnavailable) {
				warnedUnavailable = true;
				d.log({
					kind: 'av_unavailable',
					message: `No antivirus scanner available (${result.detail ?? 'unknown'}); imports proceed unscanned.`
				});
			}
			break;
		case 'error':
			d.log({
				kind: 'av_error',
				message: `Scan failed (engine=${result.engine ?? '?'}, ${result.detail ?? 'unknown'}, ${result.ms} ms); import proceeds unscanned.`
			});
			break;
	}
	return result;
}
