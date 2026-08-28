/**
 * Shared between indexer/embed.ts (writes) and src/lib/server/retrieve.ts (reads).
 * Keeping this in one file is what stops the two prefixes/dims from drifting apart
 * (see vault-rag-index skill). Changing EMBED_MODEL or EMBED_DIMS requires
 * `npm run index -- --full` to rebuild the vec table with the new dimension.
 *
 * Why bge-m3 and not nomic-embed-text: nomic is English-centric, and this app's
 * users write Turkish. Measured against the real index, Turkish queries came
 * back clustered by LANGUAGE rather than topic — every Turkish query, whatever
 * its subject, put the corpus's Turkish files on top. For "işletim
 * sistemlerinde süreç zamanlama politikaları" the correct note ranked 154th
 * (distance 0.518) while a Turkish SvelteKit summary took 1st; the English
 * phrasing of the same question ranked it 1st at 0.205. Compared directly on
 * real chunk texts, nomic scored that SvelteKit file 0.585 against the OS
 * question — above the correct note's 0.456 — while bge-m3 scored the correct
 * note 0.626 and pushed the SvelteKit one down to 0.395.
 */
export const EMBED_MODEL = 'bge-m3';
export const EMBED_DIMS = 1024;

/**
 * Empty on purpose. nomic-embed-text REQUIRED the asymmetric
 * "search_document: " / "search_query: " instruction prefixes — omitting them
 * there measurably degraded retrieval. bge-m3 is trained without instruction
 * prefixes and prepending them only adds tokens that dilute short queries.
 * The constants are kept (rather than deleted) so retrieve.ts, indexer/embed.ts
 * and incrementalIndex.ts need no change, and so a future model that does want
 * prefixes has an obvious place to declare them.
 */
export const DOC_PREFIX = '';
export const QUERY_PREFIX = '';
