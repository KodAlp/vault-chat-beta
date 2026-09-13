---
name: vault-rag-index
description: Build and maintain the RAG indexing pipeline that embeds the Obsidian vault into a local file-based vector database (sqlite-vec) for the vault-chat app. Use this skill whenever the user mentions indexing the vault, embeddings, chunking notes, vector search, retrieval quality, re-indexing, stale index, sqlite-vec, nomic-embed-text, or asks why the chat app cannot find or cites the wrong notes. Also use it when new content types (PDFs converted by pdf2md.py, new domains) must become searchable.
---

# Vault RAG Index

A standalone Node script suite that turns the Obsidian vault's Markdown into a
searchable vector index. File-based only: **sqlite-vec** inside a single
`.db` file. No server, no Docker, no background daemon. The SvelteKit app
(`svelte-vault-chat` skill) reads this DB read-only.

> **The indexer now lives in its own repo**, `C:\Users\Alp\Desktop\vault-chat`
> — not as a subfolder of this vault repo. This skill should really be
> invoked from *that* repo going forward; the layout below is kept for
> reference but its root path no longer resolves from here. This repo's own
> `raw/` (unindexed, pre-ingest staging) is unaffected either way.

## Layout

```
vault-chat/
├── indexer/
│   ├── index-vault.ts      # full + incremental indexing entry point
│   ├── chunk.ts            # markdown → chunks
│   ├── embed.ts            # Ollama embedding calls (batched)
│   ├── db.ts               # sqlite-vec schema + upsert/delete/query
│   └── watch.ts            # optional: chokidar watcher (opt-in, not default)
├── data/
│   └── vault-index.db      # gitignored
└── package.json            # "index": "tsx indexer/index-vault.ts"
```

Run with `npm run index`. Flags: `--full` (ignore hashes, rebuild all),
`--dry-run` (report what would change, write nothing) — mirror the ergonomics
of the user's existing `pdf2md.py`.

## Frontmatter contract

Real schema, per `CLAUDE.md` invariant 2 (verified against actual wiki pages —
not aspirational): every wiki page carries YAML frontmatter with exactly
`title`, `domain` (single string, one of: math, dsa, os, system-design,
embedded, electronics, algorithms, databases, sveltekit, c, rust, asm, ...),
`level` (undergrad|grad|phd), `prerequisites`, `sources`, `updated`, `status`
(stub|draft|solid). There is no `topic`/`depth`/`domains`(plural)/`confidence`
in real content — map `topic` (display label) from `title`, `depth` from
`level`, and `domains` (array, for filtering) from `[domain]`.

The indexer must:

- parse frontmatter with `gray-matter`;
- store the mapped `topic`, `depth`, `domains` as filterable columns (domains
  as a JSON array queried with `json_each`);
- **skip** files without `title` (also accept `topic` as a fallback alias, in
  case some content ever uses it) but log them as warnings — this is expected
  and correct for non-wiki `.md` files like `cards/`, `frontier/`, `Home.md`,
  and the `wiki/_index/` MOC/index pages, which don't carry the wiki schema
  and aren't meant to be retrieval content;
- never index folders: `.obsidian/`, `templates/`, `.trash/`, `attachments/`,
  `.git/`, `node_modules/`, `vault-chat/` (the app's own tree), `.claude/`
  (agent/skill config, not vault content — its frontmatter isn't this schema
  and can even break YAML parsing), `raw/` (read-only pre-ingest staging per
  CLAUDE.md — unprocessed PDF conversions, not the curated wiki), and
  `vault-kit/` (an unrelated bootstrap template at the repo root).

## Chunking rules (`chunk.ts`)

- Split on headings (`##` and deeper), keeping each chunk's full heading
  breadcrumb (`H1 > H2 > H3`) as a `heading_path` column — retrieval quality
  depends on this context.
- Target 200–400 tokens per chunk (estimate: chars/4), hard max 512.
  Oversized sections split on paragraph boundaries.
- **Never split inside** fenced code blocks or `$$...$$` math blocks. A chunk
  boundary in the middle of a derivation destroys its meaning; treat
  display-math blocks as atomic.
- Prepend to each chunk's embedded text (not its stored display text) a
  one-line context header: `[{topic} | {heading_path}]`. This measurably
  improves retrieval for short chunks.
- Store both `display_text` (raw markdown, returned to the app) and the
  embedded variant.

## Embedding (`embed.ts`)

- Model: `nomic-embed-text` via Ollama `/api/embed` (768 dims). Keep the model
  name and dimension in one config constant — if the user switches to
  `qwen3-embedding` or similar, dimension changes must flow into the vec table
  DDL automatically (drop + rebuild with `--full`).
- Batch requests (up to 32 inputs per call). Sequential batches; do not
  parallelize aggressively — Ollama shares the GPU/RAM with chat models.
- nomic requires task prefixes: embed documents as `search_document: {text}`
  and queries as `search_query: {text}`. The query side lives in the app's
  `retrieve.ts`; keep the prefixes in a shared constant file so they cannot
  drift apart.

## Database (`db.ts`)

- `better-sqlite3` + `sqlite-vec` extension (`sqlite-vec` npm package ships
  prebuilt binaries; loads with `sqliteVec.load(db)`).
- Tables:
  - `files(path PRIMARY KEY, sha256, mtime, topic, depth, domains_json)`
  - `chunks(id INTEGER PK, path REFERENCES files, heading_path,
    display_text)`
  - `vec_chunks` — `vec0` virtual table: `embedding float[768] distance_metric=cosine`
    + `chunk_id`.
- WAL mode on; the app reads while the indexer writes.
- **sqlite-vec gotcha**: `vec0`'s rowid/PK column (`chunk_id` here) rejects a
  plain JS `number` bound via better-sqlite3 — fails with "Only integers are
  allows for primary key values" — but accepts `BigInt`. Always
  `BigInt(rowid)` when inserting into or deleting from `vec_chunks`.
- **Critical: `distance_metric=cosine` is not optional, it must be set in the
  `embedding` column definition.** sqlite-vec's `vec0` defaults to L2
  (Euclidean) distance if you don't specify it. On nomic-embed-text's
  ~768-dim vectors, L2 distance clusters almost everything in the 0.85-0.97
  range *regardless of actual semantic relevance* — meanwhile
  `retrieve.ts`'s `DISTANCE_THRESHOLD` (~0.55) is calibrated for *cosine*
  distance. Missing `distance_metric=cosine` means retrieval silently
  returns empty for nearly every query, with no error — the app looks like
  it's working (chat models are good enough to answer plausibly from their
  own training knowledge even with zero real context) until something
  actually checks whether sources came back non-empty. This exact bug
  shipped and went undetected for most of a session before a stricter
  caller (quiz generation, which hard-fails on empty retrieval) surfaced
  it. If you ever recreate `vec_chunks`'s DDL, distance_metric=cosine must
  be there, and `npm run index -- --full` is required after any change
  (dimension or distance metric are both baked into the table at creation).

## Incremental logic (`index-vault.ts`)

Same philosophy as `pdf2md.py`'s sha256 skip logic:

1. Walk the vault, compute sha256 per `.md` file.
2. Unchanged hash → skip. Changed → delete that file's chunks + vectors,
   re-chunk, re-embed, insert. New → insert. Present in DB but missing on
   disk → delete (handles renames/deletions).
3. Print a summary table: `indexed / skipped / deleted / warnings`, with
   total wall time. Log in Turkish.

The chokidar watcher in `watch.ts` is opt-in (`npm run index:watch`) and must
debounce 2s per file. Default workflow stays manual: the user runs
`npm run index` after study sessions. Do not auto-start the watcher from the
SvelteKit app.

## Retrieval contract (consumed by the app)

Expose one function signature (implemented app-side in `retrieve.ts`, but its
semantics are defined here):

```ts
retrieve(query: string, opts?: { domains?: string[]; k?: number })
  → { path, heading_path, display_text, topic, distance }[]
```

- Embed query with the `search_query:` prefix.
- KNN over `vec_chunks` (default k=8), then optional post-filter by `domains`.
- Deduplicate: max 3 chunks per source file so one long note cannot flood the
  context window.
- If the best distance is worse than a sane threshold (tune empirically,
  start ~0.55 cosine distance), return an empty list — the app must then tell
  the model "no relevant context", preventing hallucinated citations.

## Quality debugging checklist

When the user says retrieval is bad, work through in order: (1) is the index
stale (`npm run index` output)? (2) are the expected notes chunked sensibly
(inspect `chunks` for that path)? (3) query-side prefix present? (4) domain
filter too narrow? (5) threshold rejecting valid hits? Only after these,
consider switching embedding models.
