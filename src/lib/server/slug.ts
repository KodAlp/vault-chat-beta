/** kebab-case, ascii-folded — shared by library.ts (filenames) and
 * vaults.ts (vault ids). Collision handling differs per caller (filename
 * scope vs. registry scope), so only the fold itself is shared. */
/** Cap for title-derived library file names (without .md or a -N dedupe suffix):
 * a misdetected long title must not exceed NAME_MAX 255 on Linux/macOS. */
export const MAX_SLUG_LENGTH = 100;

/** Cuts a slug to maxLen and re-trims a trailing hyphen the cut may expose. */
export function capSlug(slug: string, maxLen = MAX_SLUG_LENGTH): string {
	return slug.slice(0, maxLen).replace(/-+$/, '');
}

export function foldToSlug(text: string, fallback = 'adsiz'): string {
	return (
		text
			// Turkish dotless ı (U+0131) has no canonical Unicode decomposition —
			// unlike ç/ğ/ö/ş/ü, which NFKD correctly splits into a base letter
			// plus a combining mark that the next line strips. Left alone, ı
			// falls straight through to the ascii-only replace below and turns
			// into a bare hyphen: "Kapalı" -> "kapal", "Çığlık" -> "c-gl-k".
			.replace(/ı/g, 'i')
			.replace(/İ/g, 'I')
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || fallback
	);
}
