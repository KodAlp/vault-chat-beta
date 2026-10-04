import { EXCLUDED_DIRS } from '../../../indexer/excluded-dirs';

/** Longest domain (library top-level folder) name, in code points. */
export const MAX_DOMAIN_LENGTH = 64;
/** Also bounded in UTF-8 bytes: 64 emoji would be 256 bytes, over NAME_MAX 255
 * on Linux/macOS. Leaves room for the -klasoru suffix. */
const MAX_DOMAIN_BYTES = 180;

/** Characters invalid in a Windows file name (including both slashes), control
 * characters, and invisible direction / zero-width marks. */
const STRIP = /[<>:"/\\|?*\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]/g;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

function isReservedName(name: string): boolean {
	const lower = name.toLowerCase();
	// Windows reserves the device name even with an extension (con.txt).
	const base = lower.split('.')[0].trimEnd();
	// _meta is the library-internal folder (import log, staging, attachments).
	return EXCLUDED_DIRS.has(lower) || lower === '_meta' || WINDOWS_RESERVED.test(base);
}

function capLength(s: string): string {
	const chars = Array.from(s).slice(0, MAX_DOMAIN_LENGTH);
	while (chars.length > 0 && Buffer.byteLength(chars.join(''), 'utf8') > MAX_DOMAIN_BYTES) chars.pop();
	return chars.join('');
}

/**
 * Turns a user/folder supplied domain into one safe library directory name on
 * every OS. Human readable on purpose (no slug folding): "Kitaplarim" keeps
 * its Turkish letters, but NFC-normalized so a macOS NFD name cannot create a
 * visually identical duplicate folder on Linux.
 *
 * Strips Windows-invalid and control characters (so a/b, C: and .. cannot
 * add or remove path levels), collapses whitespace, drops leading dots
 * (hidden folder) and trailing dots/spaces (invalid on Windows), caps the
 * length, and appends -klasoru to names the indexer excludes
 * (indexer/excluded-dirs.ts: files there would silently vanish on a full
 * reindex), the library-internal _meta, and Windows device names.
 * Empty results fall back to "genel".
 */
export function sanitizeDomain(raw: string): string {
	let s = String(raw ?? '')
		.normalize('NFC')
		.replace(/\s+/g, ' ')
		.replace(STRIP, '')
		.replace(/ {2,}/g, ' ')
		.trim()
		.replace(/^[.\s]+/, '');
	s = capLength(s).replace(/[.\s]+$/, '');
	if (!s) return 'genel';
	if (isReservedName(s)) s = `${s}-klasoru`;
	return s;
}
