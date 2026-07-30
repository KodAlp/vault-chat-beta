/** kebab-case, ascii-folded — shared by library.ts (filenames) and
 * vaults.ts (vault ids). Collision handling differs per caller (filename
 * scope vs. registry scope), so only the fold itself is shared. */
export function foldToSlug(text: string, fallback = 'adsiz'): string {
	return (
		text
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || fallback
	);
}
