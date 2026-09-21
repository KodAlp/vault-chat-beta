/**
 * Which retrieved parts are worth writing quiz questions about. Pure, dependency-free.
 *
 * Retrieval ranks a note's index page and its "Related"/"Sources" sections high, because they name the topic, but they
 * teach nothing: a map-of-content is a list of links, "> Related" is more links, "> Sources" is citations. On the real vault
 * 17% of all chunks (375 of 2161) are like that, they made up 20-30% of the pools the quiz generator was handed, and two of
 * four experiment quizzes drew questions from a "> Related" / "> Sources" section. The generator must not ask about them.
 */

export interface PoolChunk {
	path: string;
	heading_path: string;
	display_text: string;
}

/** Index/MOC pages and metadata folders. */
const NON_TEACHING_PATH = /(^|\/)(_index|_meta)\//;
/** The LAST heading segment names what the section is. */
const LINK_SECTION = /^(sources?|related|see also|recently added|learning path|references?|further reading|links?|backlinks?)\b/i;
/** A section this short is a heading and a link, not something to ask about. */
export const MIN_TEACHING_CHARS = 200;

export function isTeachingChunk(c: PoolChunk): boolean {
	if (NON_TEACHING_PATH.test(c.path)) return false;
	if (/^MOC\b/i.test(c.path.replace(/^.*\//, ''))) return false;
	const last = c.heading_path.split(' > ').pop()?.trim() ?? '';
	if (LINK_SECTION.test(last)) return false;
	return c.display_text.trim().length >= MIN_TEACHING_CHARS;
}

/**
 * The teaching chunks of `chunks`, best-ranked first, at most `limit`. Never returns an empty pool for a non-empty input:
 * if nothing passes the filter (a vault of nothing but link pages) the original chunks are used, because a quiz from
 * poor material is better than "no sources" for a vault that has no better material.
 */
export function selectTeachingPool<T extends PoolChunk>(chunks: readonly T[], limit: number): T[] {
	const teaching = chunks.filter(isTeachingChunk);
	return (teaching.length > 0 ? teaching : [...chunks]).slice(0, limit);
}
