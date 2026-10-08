import matter from 'gray-matter';

/**
 * "Yeniden içe aktar": a note's kept original is converted again and the fresh
 * Markdown is offered to the editor as an UNSAVED draft. These two helpers are
 * the pure part — how the old note's frontmatter and the new conversion's
 * frontmatter are combined — kept free of fs/route code so they can be tested.
 */

/** Keys the user owns: a re-conversion proposes a title/domain/level of its own, but the note's win. */
const USER_OWNED_KEYS = ['title', 'domain', 'level'] as const;

/**
 * Converter-owned keys (source_sha256, converted_by, converted_at, ...) come
 * from `newData`; title/domain/level and any key the new conversion does not
 * produce at all (tags, aliases, anything the user added) stay as in `oldData`.
 */
export function mergeReimportFrontmatter(oldData: Record<string, unknown>, newData: Record<string, unknown>): Record<string, unknown> {
	const preserved: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(oldData)) {
		if ((USER_OWNED_KEYS as readonly string[]).includes(key) || !(key in newData)) preserved[key] = value;
	}
	return { ...newData, ...preserved };
}

/** The full note text for the draft: converted body + merged frontmatter, same line endings as the old note. */
export function buildReimportedNote(oldRaw: string, convertedMd: string, body: string = matter(convertedMd).content): string {
	const merged = mergeReimportFrontmatter(matter(oldRaw).data, matter(convertedMd).data);
	const out = matter.stringify(body, merged);
	return oldRaw.includes('\r\n') ? out.replace(/\r?\n/g, '\r\n') : out;
}
