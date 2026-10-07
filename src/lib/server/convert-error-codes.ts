import type { ErrorCode } from '../errors';

/**
 * Error codes convert.py is allowed to choose for the user-facing AppError.
 * A code arriving over the child process's stdout is untrusted input, so it is
 * never handed to AppError directly — only members of this list pass, anything
 * else falls back to the generic CONVERSION_FAILED.
 */
const FORWARDED_CONVERT_CODES = ['PDF_DAMAGED'] as const satisfies readonly ErrorCode[];

export type ForwardedConvertCode = (typeof FORWARDED_CONVERT_CODES)[number];

export function forwardedConvertCode(code: unknown): ForwardedConvertCode | null {
	return typeof code === 'string' && (FORWARDED_CONVERT_CODES as readonly string[]).includes(code)
		? (code as ForwardedConvertCode)
		: null;
}
