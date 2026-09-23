---
name: source-ingest
description: Build and maintain the vault-chat app's own source library (data/library/) that removes the Obsidian dependency: one-way Obsidian vault import, conversion of PDF, DOCX, PPTX, XLSX and LaTeX documents to frontmattered Markdown via Python sidecar tools (MarkItDown by default, Marker/Docling for complex or math-heavy PDFs, Pandoc for LaTeX), and YouTube transcript ingest via yt-dlp (captions only, never video/audio download or local transcription). Use this skill whenever the user works on importing sources, the left-side library tree, document conversion quality, OCR/scanned PDFs, migrating away from VAULT_PATH, YouTube transcript import, or asks which converter to use for a given file type.
---

# Source Ingest

The app stops depending on Obsidian: it owns `data/library/` — plain
Markdown + frontmatter, organized in folders shown in the left tree.
Obsidian users import their vault with one click (copy, one-way); everyone
else imports documents directly. The indexer (`vault-rag-index`) now runs
over `LIBRARY_PATH` (keep `VAULT_PATH` as a deprecated alias for one
release).

## Library layout

```
data/library/
├── {domain}/...            # user-visible folder tree (left panel)
└── _meta/
    ├── import-log.jsonl    # every import: source, tool, warnings, sha256
    └── originals/          # optional copies of source PDFs/DOCX (setting)
```

Every library file carries the standard frontmatter (`title`, `domain`,
`level`) plus ingest provenance:

```yaml
source_file: "Oppenheim_Signals.pdf"
converted_by: "marker"        # markitdown | marker | docling | pandoc | obsidian-import | manual
converted_at: 2026-07-29
needs_review: true            # set when conversion had warnings (OCR, tables)
```

`title` defaults to H1 or filename; `domain` defaults to the target
folder the user dropped the file into; `level` defaults to
`undergraduate` — all three editable in a confirm dialog before saving.
Files with `needs_review: true` get a badge in the tree.

## Obsidian vault import

- One-way COPY, never move, never write back to the vault. Re-import
  re-uses sha256 to update only changed notes (pdf2md.py pattern).
- Preserve relative structure and existing frontmatter; map legacy field
  names if present; notes missing required fields get defaults +
  `needs_review: true` instead of being rejected.
- Rewrite `[[wikilinks]]` to standard relative md links; copy embedded
  attachments referenced by notes into the same relative location;
  skip `.obsidian/`, `templates/`, `.trash/`.
- After import: automatically run the indexer, show the summary table.

## Document conversion (Python sidecar)

Conversion tools are Python; the Node app shells out to
`ingest/convert.py` (child_process, JSON lines on stdout for progress).
Keep the sidecar's CLI contract stable:

```
python ingest/convert.py --in <file> --out-dir <dir> --tool auto|markitdown|marker|docling|pandoc [--dry-run]
```

**Tool routing (`--tool auto`)** — decision order, based on the
comparative research (MarkItDown/Docling/Marker/MinerU/Pandoc/Unstructured):

1. `.tex` → **Pandoc** (`pandoc -f latex -t gfm`). Industry standard for
   LaTeX; math survives as `$...$` natively.
2. `.docx/.pptx/.xlsx/.html/.epub` → **MarkItDown**. Lightweight, fast,
   structure-preserving; ideal default for office documents.
3. `.pdf` born-digital, simple layout → **MarkItDown** first; if the
   output smells broken (heuristics: >30% lines are 1–2 chars, or zero
   headings detected in >5 pages), escalate to Marker.
4. `.pdf` complex/scanned/math-heavy → **Marker** (default escalation:
   fast, strong on book-like documents, outputs Markdown+JSON) or
   **Docling** (`--tool docling` for papers with heavy tables/formulas —
   best table detection). Scanned pages: flag OCR exactly like
   `pdf2md.py` (`needs_review: true` + log entry) rather than silently
   emitting garbage.
5. MinerU: not in the default path (mixed-language accuracy caveats);
   RAGFlow/Unstructured: not used — chunking already belongs to
   `vault-rag-index`, do not introduce a second chunking layer.

**Post-processing for all tools**, in `ingest/postprocess.py`:
- Normalize math delimiters to `$`/`$$` (Marker/Docling may emit
  `\(`/`\[`), matching the renderer's expectations.
- Wrap a top-level `\begin{align|equation|gather}` in `$$`. Not cosmetic:
  `indexer/chunk.ts` treats only ``` fences and `$$…$$` as atomic, so a
  bare environment gets split across chunks and each half renders as a
  KaTeX error. Environments already inside `$$` or a fence are left alone.
- Strip HTML remnants, collapse >2 blank lines, fix heading level jumps
  (no H1→H3 skips; the chunker depends on sane heading trees).
- Generate the frontmatter block; never overwrite an existing
  `title/domain/level` on re-import.
- `quality_warnings()` returns what actually went wrong, and `convert.py`
  emits it in the `done` event. Until this existed, `warnings` was
  hardcoded `[]`: a 1.9 MB control-theory textbook converted to 22k lines
  with **zero headings, zero equations and 5507 `(cid:NN)` artifacts** and
  reported a clean conversion. The checks are broken font mapping, no `##`
  in a long PDF, missing paragraph breaks, and atomic blocks over 2048
  chars. Any warning also forces `needs_review: true`.

- For docling/marker PDFs, `heading_repair.py` runs first: docling drops the
  spaces in headings (98/194 `## 1.3 Linearcontrolsystems` on Trentelman),
  and `heading_path` is embedded, so half the sections lost their retrieval
  key. Spaces are copied from the PDF's own text layer (pypdf, ~5 s for 404
  pages) only when the letters match exactly and the spacing is unambiguous
  — never from a dictionary. Measured: 98 → 0, zero letters changed.
  `restructure_headings()` then demotes docling's pseudo-headings
  (`Theorem 2.19`, `Proof :`, `Remarks:`, exercise items `3.12 Let`) to
  bold paragraphs and joins `Chapter 2` with the title heading after it.
  The signal is type size in the text layer, not a word list: a heading is
  kept if it starts in larger-than-body type and covers that whole line.
  Demotion is skipped when fewer than 30% of placeable headings are large
  (documents that mark headings by weight alone). Trentelman: 22 demoted,
  all correct; 15 chapter headings joined; 0 real headings lost.

Covered by `ingest/postprocess_test.py` and `ingest/heading_repair_test.py`
(`python ingest/<name>_test.py` — not part of `npm test`, which runs tsx).

**Escalation heuristic:** `looks_broken()` also counts `(cid:NN)`
artifacts, and the page count now comes from `pypdf` rather than counting
form-feeds. MarkItDown does not reliably emit that separator, so the
"no headings in a long PDF" branch silently never ran on real books — which
is how the textbook above came back as a successful MarkItDown conversion.

**Environment:** `ingest/requirements.txt` holds the light, always-installed
deps (markitdown, yt-dlp, trafilatura, pypdf); document that pip needs
`--trusted-host` flags on this machine if SSL interception reappears.
Marker and Docling are implemented in `convert.py` but live in
`ingest/requirements-optional.txt` — they pull torch and multi-GB weights,
and the user's RAM belongs to Ollama first. `convert.py` degrades gracefully
with a clear "bu araç kurulu değil: pip install ..." message when an
unavailable tool is requested, and detects them by ImportError at call time,
so installing them later needs no code change.

## YouTube transcript ingest (Python sidecar)

A second, independent Python sidecar — `ingest/youtube_transcript.py`,
shelled out from `src/lib/server/youtubeQueue.ts` (mirrors
`convertQueue.ts`'s spawn/NDJSON/`sharedJobMutex` pattern exactly, reusing
its `pythonBin()` path resolution rather than a second copy). CLI contract:

```
python ingest/youtube_transcript.py --url <youtube-url> --out-dir <dir> --lang tr,en
```

- Uses `yt-dlp` (`skip_download: True`, `writesubtitles`/`writeautomaticsub:
  True`) to fetch **captions only** — never downloads video or audio, never
  runs local transcription (Whisper etc.). A video with neither manual nor
  automatic captions in a requested language is a clean error, not a
  fallback to something heavier.
- Language priority: walks `--lang` in order (app always passes `tr,en`);
  within a language, a **manual subtitle is preferred over an
  auto-generated one** — manual is more reliable, so `needs_review: true`
  is set on the resulting frontmatter only when the auto-generated track
  had to be used.
- VTT parsing strips cue timestamps/numbers and inline `<c>`/`<00:00:01.000>`
  tags, then drops consecutive duplicate lines — YouTube's auto-generated
  captions render as "rolling" cues where each new cue repeats most of the
  previous one's text; without dedup the transcript would be full of
  near-duplicate lines.
- Frontmatter adds `source_url`, `video_id`, `channel` on top of the same
  `postprocess.py` base (`converted_by: "youtube-transcript"`) the document
  converters use — same `title/domain/level` confirm step, same indexing.
- App integration reuses the file-upload flow's confirm/cancel endpoints
  unchanged — `POST /api/import/youtube` (JSON `{url}` instead of
  multipart) produces the exact same `{type:'ready', importId, proposed,
  warnings}` SSE shape as `POST /api/import`, staging into the same
  `stagingDir()`. Only the "how did a staged .md file get here" step
  differs; review/save/index is identical.

## App integration

- Left tree = `data/library/` folder walk (server load function), with
  rename/move/delete restricted to library scope (path-traversal guard:
  resolve and verify prefix before any fs operation).
- Upload flow: drag-drop or file picker → `POST /api/import` (multipart)
  → sidecar progress streamed as SSE → confirm dialog (frontmatter) →
  save → incremental index of just that file.
- Batch import shows the pdf2md-style summary: converted / skipped /
  needs_review / failed with per-file reasons, logged to
  `import-log.jsonl`.
- Conversion is CPU-bound and can be slow (Marker/Docling): run ONE
  conversion at a time with a queue; the user's RAM/CPU belongs to
  Ollama first.
