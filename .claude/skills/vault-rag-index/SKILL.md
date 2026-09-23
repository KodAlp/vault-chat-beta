---
name: vault-rag-index
description: Build and maintain the RAG indexing pipeline that embeds a vault-chat vault's Markdown into a local, per-vault file-based vector database (sqlite-vec + FTS5) using bge-m3. Use this skill whenever the user mentions indexing a vault, embeddings, chunking notes, vector search, retrieval quality, re-indexing, stale index, unindexed files, sqlite-vec, bge-m3, or asks why the chat app or Claude (via MCP) cannot find or cites the wrong notes. Also use it when new content types must become searchable.
---

# Vault RAG Index

A standalone Node script suite that turns a vault's Markdown into a searchable
vector index. File-based only: **sqlite-vec** inside a `.db` file per vault.
No server, no Docker, no background daemon. The SvelteKit app
(`svelte-vault-chat` skill, `src/lib/server/retrieve.ts`) reads this DB
read-only, and so does the MCP server (`mcp-server` skill) for Claude clients.

> **Corrected 2026-09-23.** This doc predates Faz 8's multi-vault registry —
> several facts below (single `data/vault-index.db`, `nomic-embed-text`,
> ~0.55 threshold) described an earlier design that no longer matches the
> code. The facts here are re-verified against the current source; when in
> doubt, the source (`indexer/chunk.ts`, `indexer/db.ts`,
> `src/lib/server/embed-config.ts`, `src/lib/server/select-chunks.ts`) is the
> actual contract, not this file.

## Layout

```
vault-chat/
├── indexer/
│   ├── index-vault.ts      # full + incremental indexing entry point (CLI: --vault, --full, --dry-run)
│   ├── chunk.ts             # markdown → chunks (also normalizeLevel, HARD_MAX_CHARS)
│   ├── embed.ts             # Ollama embedding calls (batched)
│   ├── ollama-client.ts     # standalone Ollama HTTP client (no $env dependency)
│   ├── db.ts                # sqlite-vec + FTS5 schema + upsert/delete/query
│   ├── prerequisites.ts     # prerequisite-graph resolution (Faz 4)
│   ├── walk-md.ts           # shared .md file walk, EXCLUDED_DIRS-aware
│   └── watch.ts             # optional: chokidar watcher (opt-in, not default)
├── data/
│   └── vaults/<id>/
│       ├── library/         # the vault's own root, one per registered vault
│       └── index.db          # gitignored — this vault's index only
└── package.json             # "index": "tsx indexer/index-vault.ts"
```

Run with `npm run index -- --vault <id>` — the id from `data/vaults.json`
(Ayarlar → Vault'lar in the app, or MCP's `list_vaults`). Omitting `--vault`
indexes whichever vault the app's registry currently marks active, which is
rarely what a curation or batch-import run actually wants; always pass it
explicitly. Flags: `--full` (ignore hashes, rebuild all — required after an
embedding model/dimension change), `--dry-run` (report what would change,
write nothing — genuinely read-only since 2026-09-23; earlier it still ran
schema migrations as a side effect of opening the DB).

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

## Embedding (`embed.ts`, `src/lib/server/embed-config.ts`)

- Model: **`bge-m3`** via Ollama `/api/embed`, **1024 dims** (`EMBED_MODEL`/
  `EMBED_DIMS` in `embed-config.ts` — corrected 2026-09-23, this was
  `nomic-embed-text`/768 before Faz 4/5's real-corpus measurement). Keep the
  model name and dimension in that one config constant — changing either
  requires `npm run index -- --vault <id> --full` to rebuild the vec table
  with the new dimension.
- Why bge-m3, not nomic: this corpus is Turkish-heavy, and nomic clustered
  Turkish queries by *language* rather than topic (measured: a correct OS
  note ranked 154th for a Turkish phrasing of its own question, 1st for the
  English phrasing of the identical question). See `embed-config.ts`'s doc
  comment for the full numbers.
- Batch requests (up to 32 inputs per call). Sequential batches; do not
  parallelize aggressively — Ollama shares the GPU/RAM with chat models.
  `embed()`/`indexer/ollama-client.ts` runs the query-side embed CPU-only
  (`cpuOnly: true`) so it never evicts the chat model from VRAM mid-turn.
- **bge-m3 uses no instruction prefixes** — `DOC_PREFIX`/`QUERY_PREFIX` are
  both `''` (corrected: nomic needed `search_document:`/`search_query:`,
  prepending them to bge-m3 input only dilutes short queries with tokens it
  was not trained to expect). The constants are kept, not deleted, precisely
  so a future model that does want prefixes has one place to declare them —
  don't reintroduce nomic's prefixes here without re-measuring first.

## Database (`db.ts`)

- `better-sqlite3` + `sqlite-vec` extension (`sqlite-vec` npm package ships
  prebuilt binaries; loads with `sqliteVec.load(db)`). One `index.db` per
  vault, at `data/vaults/<id>/index.db` — not a single vault-wide file.
- Tables (corrected 2026-09-23 — two columns and a whole table were missing
  from this list):
  - `files(path PRIMARY KEY, sha256, mtime, topic, depth, domains_json,
    prerequisites_json)` — `prerequisites_json` (Faz 4) is the resolved
    prerequisite-graph edge list, added by `ensureColumns` so an index built
    before Faz 4 gets it without a full rebuild.
  - `chunks(id INTEGER PK, path REFERENCES files, heading_path,
    display_text)`
  - `chunks_fts` — FTS5 virtual table mirroring `chunks`, kept in sync on
    every write (Faz 5). Backs the chat route's keyword fallback
    (`src/lib/server/keyword-search.ts`) for when the vector search comes up
    empty; `search_library`/`list_sources` (MCP) are vector-only, v1 scope.
  - `vec_chunks` — `vec0` virtual table: `embedding float[1024]
    distance_metric=cosine` + `chunk_id`.
- WAL mode on; the app reads while the indexer writes.
- **sqlite-vec gotcha**: `vec0`'s rowid/PK column (`chunk_id` here) rejects a
  plain JS `number` bound via better-sqlite3 — fails with "Only integers are
  allows for primary key values" — but accepts `BigInt`. Always
  `BigInt(rowid)` when inserting into or deleting from `vec_chunks`.
- **Critical: `distance_metric=cosine` is not optional, it must be set in the
  `embedding` column definition.** sqlite-vec's `vec0` defaults to L2
  (Euclidean) distance if you don't specify it. On bge-m3's 1024-dim vectors,
  L2 distance would similarly cluster near-meaninglessly — meanwhile
  `select-chunks.ts`'s `DISTANCE_THRESHOLD` (**0.6**, corrected — was
  measured at ~0.55 for nomic; re-measured for bge-m3, see that file's own
  doc comment for the real-index distance ranges behind the number) is
  calibrated for *cosine* distance specifically. Missing
  `distance_metric=cosine` means retrieval silently returns empty for nearly
  every query, with no error — the app looks like it's working (chat models
  are good enough to answer plausibly from their own training knowledge even
  with zero real context) until something actually checks whether sources
  came back non-empty. This exact bug shipped and went undetected for most
  of a session before a stricter caller (quiz generation, which hard-fails
  on empty retrieval) surfaced it. If you ever recreate `vec_chunks`'s DDL,
  distance_metric=cosine must be there, and `npm run index -- --vault <id>
  --full` is required after any change (dimension or distance metric are
  both baked into the table at creation).

## Incremental logic (`index-vault.ts`)

1. Walk the vault (`indexer/walk-md.ts`, `EXCLUDED_DIRS`-aware — shared with
   the unindexed-file-count signal below), compute sha256 per `.md` file.
2. Unchanged hash → skip, **unless** one of that file's existing chunks
   already exceeds `HARD_MAX_CHARS` (corrected 2026-09-23 — an oversized
   chunk produced before a chunker fix used to stay oversized forever,
   because nothing ever forced a re-chunk of a file whose hash hadn't
   moved). Changed → delete that file's chunks + vectors, re-chunk,
   re-embed, insert. New → insert. Present in DB but missing on disk →
   delete (handles renames/deletions).
3. Print a summary table: `indexed / skipped / yeniden bölünen / deleted /
   warnings`, with total wall time. Log in Turkish.

The chokidar watcher in `watch.ts` is opt-in (`npm run index:watch`) and must
debounce 2s per file. Default workflow stays manual: the user runs
`npm run index -- --vault <id>` after study sessions. Do not auto-start the
watcher from the SvelteKit app.

### Unindexed-file signal (added 2026-09-23)

A curation pass that writes new curated notes but is never followed by
`npm run index` leaves them sitting on disk, invisible to search and to
Claude, with nothing surfacing that anywhere — this was the exact gap the
`knowledge-editor` skill's own reindex proposal used to fall through.
`src/lib/server/retrieve.ts`'s `countUnindexedFiles(v)` compares
`walkMarkdownFiles(v.libraryRoot).length` against the vault's raw `files`
table count (not `listSources()`'s hidden-folder-filtered total — a
`cards/`/`frontier/` file that's indexed is not "unindexed", just hidden
from that listing) and is exposed as `unindexedCount` on MCP's `list_vaults`
and on `GET /api/vaults` (the app's own vault picker/settings UI).

## Retrieval contract (consumed by the app)

Implemented in `src/lib/server/retrieve.ts` (KNN + fallback orchestration)
and `src/lib/server/select-chunks.ts` (pure post-filter — deliberately
dependency-free so it runs under plain `tsx --test`, unlike `retrieve.ts`
itself, which pulls in `$env/dynamic/private` transitively):

```ts
retrieve(v: VaultContext, query: string, opts?: { domains?: string[]; levels?: string[]; includedPaths?: string[]; k?: number; keywordFallback?: boolean })
  → { chunks: RetrievedChunk[]; narrowScope: boolean; reason?: string }
```

- Embed query — **no prefix** (bge-m3; see Embedding above).
- KNN over `vec_chunks` (default k=8), then filtered in order: hidden
  folders (`raw`/`cards`/`frontier`/`notes`/`wiki/_index`, unconditional) →
  scope (`includedPaths`) → `domains` (case-insensitive) → `levels`
  (case-insensitive **and** synonym-folded via `normalizeLevel`, corrected
  2026-09-23 — a caller typing `undergraduate` must still match a chunk
  stored as the canonical `undergrad`).
- Deduplicate: max 3 chunks per source file so one long note cannot flood the
  context window.
- Distance threshold **0.6** cosine (corrected, was ~0.55) — below it,
  results drop entirely and the caller gets `reason: 'filtered'`/`'scope'`;
  the app must then tell the model "no relevant context", preventing
  hallucinated citations.
- Chat only (never the study-artifact generators, which must cite only what
  vector search actually found): `keywordFallback` tries an FTS5 AND query
  over `chunks_fts` when the vector search returns nothing usable — the
  fallback query is only the newest user message, gated to ≥2 real terms
  (`keyword-query.ts`), never a substitute source of truth.

## Quality debugging checklist

When the user says retrieval is bad, work through in order: (1) is the right
vault even being searched (`--vault` on the CLI; `list_vaults` on MCP)? (2)
is the index stale (`npm run index -- --vault <id>` output, or
`unindexedCount` on `list_vaults`/`GET /api/vaults`)? (3) are the expected
notes chunked sensibly (inspect `chunks` for that path)? (4) domain/level
filter too narrow, or case/synonym-mismatched with what's actually stored?
(5) is the file sitting under a hidden folder (`cards/frontier/notes/
wiki/_index`) — indexed but never searchable by design? (6) threshold
rejecting valid hits? Only after these, consider switching embedding models.
