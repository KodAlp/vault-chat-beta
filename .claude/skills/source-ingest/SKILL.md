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
source_sha256: "…"            # of the ORIGINAL file's bytes (2026-09-23) — content-addressed
                               # dedup, not the curated Markdown's own hash (that's `sha256` in
                               # import-log.jsonl, answers "did this note change", not "was this
                               # exact source ever imported before under a different name/URL")
converted_by: "marker"        # markitdown | marker | docling | pandoc | already-markdown | trafilatura | youtube-transcript | obsidian-import | manual
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
python ingest/convert.py --in <file> --out-dir <dir> --tool auto|markitdown|marker|docling|pandoc [--dry-run] [--source-name <name>]
```

`--source-name` (2026-09-23): every caller stages the input under a generic
name (`original.pdf`) before invoking this script, so `--in`'s own stem is
never a usable title or provenance record — five real PDFs all came back
titled "original"/"input" before this existed. Pass the real filename (or,
for a link import, `sourceNameFromUrl`'s URL-path-segment guess); it becomes
`source_file` frontmatter and the title fallback when the document has no
title of its own. Omitted by a caller that doesn't have one → old, worse
fallback (the staged name), never a crash.

**Tool routing (`--tool auto`)** — decision order, based on the
comparative research (MarkItDown/Docling/Marker/MinerU/Pandoc/Unstructured):

1. `.md` → **no tool at all** (2026-09-23, Ö6) — already Markdown. Any
   frontmatter the source already carries is split off before
   `postprocess()` runs (never mistaken for body text), and its own `title`
   (if present) outranks the filename fallback the same way a PDF's own
   metadata Title does. Neither source frontmatter nor a body H1 has one? →
   filename fallback, `needs_review: true`, and a warning naming that.
2. `.tex` → **Pandoc** (`pandoc -f latex -t gfm`). Industry standard for
   LaTeX; math survives as `$...$` natively.
3. `.docx/.pptx/.xlsx/.html/.epub` → **MarkItDown**. Lightweight, fast,
   structure-preserving; ideal default for office documents. `.pptx`
   (2026-09-23, K2-7): MarkItDown makes every slide's title an H1 — a
   29-slide deck came back as 29 top-level H1s — so pptx output gets every
   H1 demoted to H2 (outside fenced/verbatim regions) after conversion.
4. `.pdf` born-digital, simple layout → **MarkItDown** first; if the
   output smells broken (heuristics: >30% lines are 1–2 chars, or zero
   headings detected in >5 pages), escalate to Marker.
5. `.pdf` complex/scanned/math-heavy → **Marker** (default escalation:
   fast, strong on book-like documents, outputs Markdown+JSON) or
   **Docling** (`--tool docling` for papers with heavy tables/formulas —
   best table detection). Scanned pages: flag OCR exactly like
   `pdf2md.py` (`needs_review: true` + log entry) rather than silently
   emitting garbage. A false "looks scanned" positive on a real text layer
   (S9, 2026-09-23) no longer discards the extracted text outright when
   escalation is unavailable/fails — a ≥200-char MarkItDown pass is kept,
   flagged `needs_review`, rather than losing real content to a bad heuristic.
6. MinerU: not in the default path (mixed-language accuracy caveats);
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
- `derive_title()` takes the first H1, falling back to the caller's
  `title_fallback` when there is none. It also strips markdown link markup
  from that H1 (2026-09-23, K3-7): some web-book HTML wraps a
  self-referencing anchor around its heading (`# [Scanning4](#top)`), which
  without this became the literal bracketed-and-linked string as the note's
  title rather than "Scanning4".
- `quality_warnings()` returns what actually went wrong, and `convert.py`
  emits it in the `done` event. Until this existed, `warnings` was
  hardcoded `[]`: a 1.9 MB control-theory textbook converted to 22k lines
  with **zero headings, zero equations and 5507 `(cid:NN)` artifacts** and
  reported a clean conversion. The checks are broken font mapping, no `##`
  in a long PDF, missing paragraph breaks, and atomic blocks over 2048
  chars. Any warning also forces `needs_review: true`.
- `convert.py` never silently overwrites an existing output file (K2,
  2026-09-23) — a name collision in `--out-dir` gets a numeric suffix
  (`unique_output_path`), the first free `<stem>-N.md` wins.
- PDF title derivation (K2-5, 2026-09-23): metadata `Title` → the single
  largest-font run in the first few pages (page-bounded, not
  fragment-count-bounded — an unbounded window let a later chapter heading
  like "Preface" outscore the real, smaller-font title) → `--source-name`'s
  filename. "original"/"input" (the staged name) is never the title.

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

Covered by `ingest/postprocess_test.py`, `ingest/heading_repair_test.py` and
`ingest/convert_test.py` (title derivation, `.pptx` heading demotion,
`unique_output_path`, `split_existing_frontmatter`) — `python
ingest/<name>_test.py`, not part of `npm test`, which runs tsx.

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
  True`, `noplaylist: True`) to fetch **captions only** — never downloads
  video or audio, never runs local transcription (Whisper etc.). A video
  with neither manual nor automatic captions in a requested language is a
  clean error, not a fallback to something heavier. `noplaylist` (added
  2026-09-23): a `watch?v=...&list=...` link — MIT OCW's own channel pages
  are exactly this shape — is a playlist URL to yt-dlp, and without it every
  video in the list gets processed while holding `sharedJobMutex`, locking
  out chat's model swap until the whole list finishes.
- Language selection (rewritten 2026-09-23 — see `find_subtitle_file`,
  `_find_manual_key`, `_find_auto_original_key`): walks `--lang` in order
  (app always passes `tr,en`); within a language, a **manual subtitle is
  preferred over an auto-generated one**, so `needs_review: true` is set on
  the resulting frontmatter only when the auto-generated track had to be
  used. Two corrections, both measured on a real MIT OCW video
  (`ryLdyDrBfvI`):
  - A manual track's key is not always the bare language code — that
    video's English manual caption was keyed `en-qlPKC2UN_YU`. Matching is
    now by prefix (`{lang}-*`, BCP-47-shaped), not exact string equality,
    which used to fall straight through to the auto-generated track.
  - An auto-generated track is only accepted as the video's own
    `-orig` (untranslated) track, or the bare key when it provably matches
    the video's own `language` — never a bare requested-language key on
    faith. YouTube auto-translates its auto-captions into every UI language
    it supports, so `automatic_captions['tr']` on an English video is a
    machine translation of the English auto-caption, not a Turkish
    original; requesting `tr,en` used to pick exactly that translation over
    the far more accurate `en-orig` track.
  - `ydl_opts['subtitleslangs']` requests `"{lang}(-.*)?"` per language, not
    the bare code — yt-dlp treats each entry as a regex against its own
    available caption keys, so a bare `"en"` only ever downloads a track
    keyed exactly `en`, never `en-orig` or a suffixed manual key; without
    the wider pattern the files the selection logic above needs never get
    written to disk in the first place.
  - Selected `frontmatter["language"]` is the base code of whichever key was
    actually used (`en` for `en-qlPKC2UN_YU` or `en-orig` alike) — new
    field, was absent before.
- VTT parsing strips cue timestamps/numbers and inline `<c>`/`<00:00:01.000>`
  tags, then drops consecutive duplicate lines — YouTube's auto-generated
  captions render as "rolling" cues where each new cue repeats most of the
  previous one's text; without dedup the transcript would be full of
  near-duplicate lines.
- Frontmatter adds `source_url`, `video_id`, `channel`, `language` on top of
  the same `postprocess.py` base (`converted_by: "youtube-transcript"`) the
  document converters use — same `title/domain/level` confirm step, same
  indexing.
- `youtubeQueue.ts` now carries the same `PROCESS_TIMEOUT_MS` (120s)
  kill-on-hang guard as `convertQueue.ts`/`webExtractQueue.ts` (added
  2026-09-23 — it was the one process spawner in the app with none).

Covered by `ingest/youtube_transcript_test.py` (`python
ingest/youtube_transcript_test.py`) — same convention as
`postprocess_test.py`/`heading_repair_test.py` above, not part of `npm test`.
- App integration reuses the file-upload flow's confirm/cancel endpoints
  unchanged — `POST /api/import/youtube` (JSON `{url}` instead of
  multipart) produces the exact same `{type:'ready', importId, proposed,
  warnings}` SSE shape as `POST /api/import`, staging into the same
  `stagingDir()`. Only the "how did a staged .md file get here" step
  differs; review/save/index is identical.

## Web page extraction (Python sidecar)

A third sidecar, `ingest/extract_web.py`, shelled out from
`src/lib/server/webExtractQueue.ts`. The Node route
(`api/import/links/+server.ts`) does the one HTTP fetch itself — through
`fetchWithCap`/`assertPublicHost` in `src/lib/server/link-import.ts`, the
SSRF-hardened path documented in that module, not here — and hands this
script the already-downloaded HTML:

```
python ingest/extract_web.py --in <html-file> --url <original-url> --out-dir <dir>
```

- `trafilatura.extract(..., with_metadata=True)` (2026-09-23) — without it,
  a page with no H1 fell back to `title_fallback=args.url`, the raw URL
  string, as its title. `parse_trafilatura_metadata()` splits the
  `---\nkey: value\n---\n` block trafilatura prepends (its own fixed
  format, not real YAML — `pyyaml` is only a transitive dependency of the
  optional docling/marker extras, so web extraction, a core feature, isn't
  made to depend on it). Title now comes from `meta.title` (the page's own
  `<title>`/metadata) → `title_from_url()` (the URL's last path segment,
  percent-decoded) → the H1-or-fallback logic `postprocess.py`'s
  `derive_title()` already applies to every other converter.
- Links import (`api/import/links/+server.ts`) now stages every result —
  PDF or HTML alike — through the same `stagingDir()` → confirm flow file
  and YouTube uploads use, instead of writing straight into the library.
  It also redirects a YouTube URL submitted through the generic link box
  to the transcript sidecar above (`isYoutubeUrl()`,
  `link-import.ts`) rather than fetching it as an ordinary web page.

Covered by `ingest/extract_web_test.py` (`parse_trafilatura_metadata`,
`title_from_url`) and `src/lib/server/link-import.test.ts`
(`fetchWithCap`, `nextRedirectTarget`, `pdfContentTypeMismatch`,
`isYoutubeUrl`, `describeError`).

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
- The confirm step (`api/library/import/[id]/confirm`) is shared by all
  three sources (file, YouTube, link) — a fix here covers all three at
  once. If indexing fails after the file already landed in the library
  tree (2026-09-23, #11), it's removed and the staged copy restored rather
  than left behind unindexed with no signal; the log gets an
  `"indekslenmedi"` entry and the client sees the actual reason, not a
  generic "kaydedilemedi".
