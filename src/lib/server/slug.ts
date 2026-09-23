/** kebab-case, ascii-folded — shared by library.ts (filenames) and
 * vaults.ts (vault ids). Collision handling differs per caller (filename
 * scope vs. registry scope), so only the fold itself is shared. */
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
