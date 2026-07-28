/**
 * Shared between indexer/embed.ts (writes) and src/lib/server/retrieve.ts (reads).
 * Keeping this in one file is what stops the two prefixes/dims from drifting apart
 * (see vault-rag-index skill). Changing EMBED_MODEL or EMBED_DIMS requires
 * `npm run index -- --full` to rebuild the vec table with the new dimension.
 */
export const EMBED_MODEL = 'nomic-embed-text';
export const EMBED_DIMS = 768;
export const DOC_PREFIX = 'search_document: ';
export const QUERY_PREFIX = 'search_query: ';
