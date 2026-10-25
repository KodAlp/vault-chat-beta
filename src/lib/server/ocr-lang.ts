/**
 * OCR language argument for convert.py (`--ocr-lang`).
 *
 * The vault's `allowedLanguages` are free-text names ("Türkçe", "English");
 * convert.py (ingest/ocr_lang.py) maps names and ISO codes to the OCR engine's
 * codes and warns in Turkish when the installed models cannot read a script.
 * So the server only forwards text: a per-import choice wins over the vault's
 * languages, and nothing at all means "engine default".
 */

const MAX_LEN = 80;

/** Keep only what a language list can legitimately contain (letters of any
 * script, digits, space, comma, hyphen, underscore, dot); drop everything else
 * so the value is always a harmless single CLI argument. */
export function sanitizeOcrLang(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined;
	const cleaned = raw
		.normalize('NFC')
		.replace(/[^\p{L}\p{M}\p{N} ,._-]/gu, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_LEN)
		.trim();
	// An argument starting with '-' would be read by argparse as a flag.
	const safe = cleaned.replace(/^[-.,_ ]+/, '');
	return safe || undefined;
}

/** `override` (a per-import choice, "" or "auto" = none) else the vault's languages. */
export function ocrLangArg(override: unknown, allowedLanguages: readonly string[] | undefined): string | undefined {
	const picked = sanitizeOcrLang(override);
	if (picked && picked.toLowerCase() !== 'auto') return picked;
	return sanitizeOcrLang((allowedLanguages ?? []).join(', '));
}
