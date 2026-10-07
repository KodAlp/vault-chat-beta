import { AppError } from './app-error';

/**
 * docling-parse (#357): on Windows the MinGW build corrupts the heap while its
 * render thread shuts down, so the converter process dies natively — most
 * often on PDFs that embed CMYK JPEGs, rarely on others. A retry usually
 * succeeds, so a native crash gets one automatic second attempt.
 */

// Windows NTSTATUS exit codes of a native crash. Deliberately an explicit
// set, not "any 0xC000xxxx": 0xC0000142 (STATUS_DLL_INIT_FAILED, 3221225794 —
// the Store python.exe alias, see convertQueue.ts) is deterministic, so a
// retry would only repeat it and delay the real error.
const WINDOWS_CRASH_CODES = new Set<number>([
	0xc0000005, // STATUS_ACCESS_VIOLATION
	0xc0000374, // STATUS_HEAP_CORRUPTION
	0xc0000409 // STATUS_STACK_BUFFER_OVERRUN (fail-fast abort)
]);

const POSIX_CRASH_SIGNALS = new Set<string>(['SIGSEGV', 'SIGBUS', 'SIGABRT', 'SIGILL']);

/**
 * True when the child died from a native fault. Our own timeout kill
 * (SIGTERM) is never a crash — the caller also checks its timedOut flag.
 */
export function isNativeCrash(code: number | null, signal: NodeJS.Signals | null): boolean {
	if (code !== null) return WINDOWS_CRASH_CODES.has(code >>> 0);
	return signal !== null && POSIX_CRASH_SIGNALS.has(signal);
}

/** Result of a single attempt. Anything but `crash` is final. */
export type AttemptOutcome<T> =
	| { kind: 'done'; value: T }
	| { kind: 'error'; error: AppError }
	| { kind: 'crash'; detail: string };

/**
 * Runs `attempt` and, only if it reports a native crash, once more. A second
 * crash becomes CONVERTER_CRASHED; done, error and timeout (an `error`
 * outcome carrying PROCESS_TIMEOUT) are never retried.
 */
export async function runWithCrashRetry<T>(
	attempt: () => Promise<AttemptOutcome<T>>,
	onRetry: (firstCrashDetail: string) => void
): Promise<T> {
	let outcome = await attempt();
	if (outcome.kind === 'crash') {
		onRetry(outcome.detail);
		outcome = await attempt();
	}
	if (outcome.kind === 'done') return outcome.value;
	if (outcome.kind === 'error') throw outcome.error;
	throw new AppError('CONVERTER_CRASHED', { detail: outcome.detail });
}
