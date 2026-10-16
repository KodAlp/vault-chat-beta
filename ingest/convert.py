#!/usr/bin/env python3
"""Conversion sidecar — CLI contract owned by the source-ingest skill doc:

    python ingest/convert.py --in <file> --out-dir <dir> --tool auto|markitdown|marker|docling|pandoc [--dry-run] [--source-name <name>] [--pages START-END] [--pdf-backend default|hybrid] [--no-images]

JSON-lines progress on stdout, one object per line:
    {"type": "progress", "stage": "..."}
    {"type": "done", "outPath": "...", "warnings": [...], "images": ["<sha16>.png", ...], "imageStats": {...}}
    {"type": "error", "message": "..."}

Serve mode (2026-10-08): `python convert.py --serve` is a long-lived worker for
the Node side (src/lib/server/convert-worker.ts). It reads one JSON request per
stdin line, {"id": "...", "args": [<the CLI args above>]}, runs main(args), and
stamps "id" on every event it emits; after main returns it emits
{"type": "end", "id": "...", "exit": 0|1}. A failing request never stops the
worker (an escaping exception becomes an `error` + `end`); EOF on stdin exits
0. Why: docling's models (the formula recognizer alone is ~20-45 s on the
RTX 4050) were reloaded for every file; the worker keeps one DocumentConverter
(see _shared_converter) so only the first PDF pays for the load.

Marker and Docling are implemented but remain optional heavy extras (PyTorch,
multi-GB model weights) — they are commented out of requirements.txt. Requesting
one that is not installed, or auto-routing a PDF that needs it, reports a clear
"not installed" message instead of crashing or silently emitting garbage.
Detection is by ImportError at call time, not a hardcoded capability flag, so
installing them later needs no change here.

PDF routing under `--tool auto` (2026-10-07, measured on 5 real PDFs): on a
machine with a GPU (CUDA/MPS) docling runs FIRST and MarkItDown is only the
fallback; without one, MarkItDown runs first and escalates when its output
looks broken or a page has no text layer. `VC_PDF_PRIMARY=docling|markitdown`
overrides the choice. See route_auto for the numbers behind it. PPTX/DOCX/XLSX
stay MarkItDown-first.

Hugging Face is offline-first for docling/marker (see hf_offline_first): the
models are already in the local cache, and without the flag every conversion
process still made network requests to huggingface.co.

--source-name (2026-09-23, E5/K2-5): every caller (upload, batch upload, link
import) stages the input under a generic name (`original.pdf`) before calling
this script, to keep the staging dir collision-free — so --in's own stem is
never a usable title or source record. Pass the REAL filename here; it
becomes source_file frontmatter and the title fallback when the document has
no usable title of its own. Callers that omit it get the old (worse)
behavior — the staged name — never a crash.

--pdf-backend (default|hybrid): which docling PDF backend to use. `default` is
docling's own; `hybrid` (ingest/hybrid_backend.py) is the FALLBACK that avoids
docling-parse#357 (native crash on Windows) and #354 (non-ASCII profile path),
at a measured quality/speed cost. Only the docling path reads it. With
`default`, an "opening the document" failure is retried once with `hybrid`
automatically; the caller (convertQueue.ts) passes `hybrid` itself on the
second attempt after a native crash. A conversion that used hybrid carries a
warning (hence needs_review).

Images (2026-10-07; see images.py for the full design): pictures in docling
PDFs, PPTX and DOCX are written to `<out-dir>/images/<sha16>.<ext>` and the
Markdown refers to them as `images/<sha16>.<ext>`; the `done` event lists the
file names (`images`) and the per-filter counts (`imageStats`). Every kept
picture is a three-line block, and the HTML comment is the hook a future VLM
pass uses to find it and insert/replace the description line:

    ![<alt>](images/<sha16>.<ext>)
    <!-- vc:gorsel <sha16> -->
    *Görsel:* <author alt text>      (only when trustworthy text exists)

--no-images turns all of it off (the old output: docling placeholders, no
PPTX/DOCX pictures). The Node side moves the files into the vault's
_meta/attachments/ and rewrites the links (src/lib/server/converted-images.ts).
"""
from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable

import formula_crop
import formula_early_stop
import formula_fallback
import images
import code_layout
import glyph_check
import ocr_lang
import ocr_math_check
import pdf_tounicode
from column_order import repair_document_order
from reading_order import repair_reading_order
from heading_repair import body_size, read_text_layer, repair_headings, restructure_headings
from postprocess import _apply_outside_verbatim, is_junk_title, postprocess, quality_warnings

MARKITDOWN_EXTS = {".docx", ".pptx", ".xlsx", ".html", ".htm", ".epub"}
PDF_EXT = ".pdf"
TEX_EXT = ".tex"
MD_EXT = ".md"

# Kod dosyaları, Seçenek B (rapor §5.2, Aşama 11): "tek dosyalık örnekler
# için" — a whole-repo import is option D, out of scope here. Extension ->
# Shiki language id, kept in sync BY HAND with src/lib/markdown.ts's LANGS
# array (two different language runtimes, no shared module) so a wrapped
# file actually gets highlighted instead of rendering as a plain block.
# `.html`/`.htm` are deliberately absent — those already go through
# MARKITDOWN_EXTS as real documents; a code-file entry here would make the
# same extension mean two different things depending on which set a caller
# checked first.
CODE_EXTENSIONS = {
    ".js": "javascript",
    ".ts": "typescript",
    ".py": "python",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".rs": "rust",
    ".sh": "bash",
    ".json": "json",
    ".css": "css",
    ".svelte": "svelte",
    ".sql": "sql",
    ".asm": "asm",
    ".s": "asm",
}

# Heuristic straight from the skill doc: escalate a MarkItDown PDF result
# that smells broken rather than trusting it.
SHORT_LINE_RATIO_THRESHOLD = 0.3
MIN_PAGES_FOR_HEADING_CHECK = 5
CID_ARTIFACT = re.compile(r"\(cid:\d+\)")
# A handful can appear in any PDF; hundreds mean the font mapping is gone.
CID_ARTIFACT_THRESHOLD = 50
# Below this, a MarkItDown pass that "looks broken" and couldn't be escalated
# has nothing worth salvaging (S9's false-positive fallback below only makes
# sense with real extracted text to fall back TO).
MIN_FALLBACK_CHARS = 200


# Serve mode (--serve): id of the request being handled. Every emitted event
# carries it so the Node side can route lines to the right request. None in
# the plain CLI, where the output is exactly what it always was.
_REQUEST_ID: list[str | None] = [None]


def emit(obj: dict) -> None:
    if _REQUEST_ID[0] is not None:
        obj = {**obj, "id": _REQUEST_ID[0]}
    print(json.dumps(obj), flush=True)


class PdfDamagedError(Exception):
    """The PDF is truncated or corrupt, or a converter returned fewer pages
    than the file has. Deliberately NOT a RuntimeError: route_auto's S9
    fallback catches RuntimeError and would hand back the MarkItDown text as
    a "successful" conversion of a document that is missing pages. This must
    propagate to main() and become a PDF_DAMAGED error instead."""


PDF_DAMAGED_MESSAGE = "PDF eksik ya da bozuk görünüyor; dosya yarım inmiş olabilir. Yeniden indirip deneyin."


# A line is "large" when its size exceeds the body size by this factor —
# same threshold heading_repair.py uses to tell a real heading from a
# body-size run-in label, reused here for the same reason: it is the one
# signal that has actually been measured to separate title-sized text from
# prose on a real book (Trentelman: body 10.0pt, chapter titles 20.7/24.8pt).
_LARGE_TITLE_FACTOR = 1.15
# Title search window, in PAGES (not fragments — a page count is what
# actually keeps this away from unrelated large text deeper in the
# document). Measured on Trentelman: pages 1-3 (repository cover sheet +
# real title page) correctly isolate the 17.2pt title; page 4 is where
# "Preface" (a 24.8pt chapter heading) would start outscoring it if the
# window were any wider.
_TITLE_SEARCH_PAGES = 3


def pdf_title_from_metadata(path: Path) -> str | None:
    """The PDF's own /Title field, when it looks like a real title and not
    a placeholder some tool wrote (empty, or literally the filename)."""
    try:
        from pypdf import PdfReader

        meta = PdfReader(str(path)).metadata
        title = (meta.title or "").strip() if meta else ""
        return title or None
    except Exception:  # noqa: BLE001 — a title guess is a heuristic input, not a result
        return None


def pdf_title_from_first_large_line(path: Path) -> str | None:
    """The run of text set at the single largest size near the start of the
    document — the visual title, used when the PDF carries neither a usable
    metadata Title nor a Markdown H1 in the converted body (K2-5: those two
    gaps are exactly how a converted PDF ends up titled "original" or
    "input", the staged filename convert.py was actually invoked with).

    Reuses heading_repair.py's own size machinery (read_text_layer,
    body_size) rather than a second PDF-layout reader — fragments are
    already in page/reading order.

    Not simply "the first run above the body-size threshold": measured on a
    real repository-hosted PDF (Trentelman), the actual first page is an
    auto-generated cover sheet whose institution/title/author block is all
    set at one size (12.0pt, against an 8.0pt body on that page) — large
    enough to clear the threshold, but not the real title, which sits on
    the *next* page at 17.2pt. Taking the first "large enough" run picked
    the cover sheet's three-line jumble instead; the true title is the run
    at the single largest size in the window, wherever it first occurs.
    Also measured: the window has to be page-bounded, not fragment-count-
    bounded — with the first ~200 fragments (past page 3), "Preface" (a
    24.8pt chapter heading) outscored the 17.2pt title.
    """
    _lines, window = read_text_layer(path, max_pages=_TITLE_SEARCH_PAGES)
    return title_from_fragments(window)


def title_from_fragments(window: list[tuple[str, float]]) -> str | None:
    """The pure selection logic behind pdf_title_from_first_large_line,
    split out so it can be tested without a real PDF on disk — see that
    function's doc comment for what it does and why."""
    if not window:
        return None
    limit = body_size(window) * _LARGE_TITLE_FACTOR
    sizes_above_limit = [size for _text, size in window if size >= limit]
    if not sizes_above_limit:
        return None
    max_size = max(sizes_above_limit)
    words: list[str] = []
    for text, size in window:
        if size >= max_size - 0.05:  # float rounding, not a real size difference
            words.append(text)
        elif words:
            break  # the max-size run ended
    title = " ".join(words).strip()
    return title or None


def derive_pdf_title(path: Path) -> str | None:
    """3-tier fallback (K2-5): metadata Title, then the first large-font
    line, then None — the caller falls back further to the real source
    filename (never in_path.stem, which is the staged "original"/"input").
    Only consulted when the converted body has no H1 of its own
    (postprocess.py's derive_title already prefers a real H1)."""
    # Each candidate must survive is_junk_title (metadata Title "******",
    # "PowerPoint Presentation", "Microsoft Word - x.doc", ...) or the next
    # tier is tried.
    for candidate in (pdf_title_from_metadata(path), pdf_title_from_first_large_line(path)):
        if not is_junk_title(candidate):
            return candidate
    return None


def pdf_page_count(path: Path) -> int:
    """MarkItDown does not reliably emit the form-feed page separator this code
    used to count, so the heading check below silently never ran on real books:
    a 22k-line control-theory textbook came back with zero headings, zero
    equations and 5507 (cid:NN) artifacts, and was reported as a clean
    MarkItDown conversion. Read the page count from the PDF itself instead.
    """
    try:
        from pypdf import PdfReader

        return len(PdfReader(str(path)).pages)
    except Exception:  # noqa: BLE001 — a page count is a heuristic input, not a result
        return 0


# Pages with fewer extracted characters than this count as "no text layer".
TEXTLESS_MIN_CHARS = 20
_TEXTLESS_CACHE: dict[tuple[str, int, int], list[int]] = {}


def textless_pages(path: Path, min_chars: int = TEXTLESS_MIN_CHARS) -> list[int]:
    """1-indexed IMAGE-ONLY pages: extractable text shorter than `min_chars`
    after strip AND at least one image object (a scan). A truly blank page (a
    separator page in a book) has neither and is not reported — flagging it
    produced false "no text layer" warnings and needless escalation.
    looks_broken() judges the whole
    document, so a 2-page PDF whose page 2 was a scanned image (0 chars) came
    back as the cover page alone, status ready, no warning (2026-10-07).

    pypdfium2 first (a docling dependency, ~2.7 ms/page measured: 18 p in 0.06 s,
    769 p in 2.1 s), pypdf as the fallback. No page cap: even a 1200-page book
    costs ~3 s against minutes of conversion. Any error -> [] (a heuristic
    input, never a reason to fail a conversion). Cached per process so main()
    and route_auto() do not scan twice.
    """
    try:
        st = path.stat()
        key = (str(path.resolve()), st.st_mtime_ns, st.st_size)
    except OSError:
        return []
    if key in _TEXTLESS_CACHE and min_chars == TEXTLESS_MIN_CHARS:
        return list(_TEXTLESS_CACHE[key])
    result: list[int] = []
    try:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(str(path))
        try:
            for i in range(len(pdf)):
                page = pdf[i]
                try:
                    textpage = page.get_textpage()
                    try:
                        text = textpage.get_text_range()
                    finally:
                        textpage.close()
                    # 3 == FPDF_PAGEOBJ_IMAGE; only looked up for short pages.
                    has_image = len(text.strip()) < min_chars and any(
                        True for _ in page.get_objects(filter=[3])
                    )
                finally:
                    page.close()
                if has_image:
                    result.append(i + 1)
        finally:
            pdf.close()
    except Exception:  # noqa: BLE001 — try pypdf below
        try:
            from pypdf import PdfReader

            result = []
            for i, p in enumerate(PdfReader(str(path)).pages):
                if len((p.extract_text() or "").strip()) >= min_chars:
                    continue
                try:
                    has_image = len(p.images) > 0
                except Exception:  # noqa: BLE001 — unknown = do not flag
                    has_image = False
                if has_image:
                    result.append(i + 1)
        except Exception:  # noqa: BLE001 — a heuristic input, not a result
            return []
    if min_chars == TEXTLESS_MIN_CHARS:
        _TEXTLESS_CACHE[key] = list(result)
    return result


def textless_pages_in_scope(path: Path, page_range: tuple[int, int] | None) -> list[int]:
    """textless_pages restricted to the pages actually converted (--pages)."""
    pages = textless_pages(path)
    if page_range is None:
        return pages
    start, end = page_range
    return [n for n in pages if start <= n <= end]


def accelerator_available() -> bool:
    """True when torch can see a CUDA or Apple MPS device. Any import or
    runtime error means False (docling would not be usable at a sane speed)."""
    try:
        import torch

        if torch.cuda.is_available():
            return True
        mps = getattr(torch.backends, "mps", None)
        return bool(mps is not None and mps.is_available())
    except Exception:  # noqa: BLE001 — no torch / broken install = no accelerator
        return False


def pdf_primary_tool() -> str:
    """Which converter runs FIRST for a PDF under --tool auto: "docling" or
    "markitdown". VC_PDF_PRIMARY overrides; anything else/unset = auto by
    accelerator (docling costs 23-79 s/page on CPU, ~3 s/page on GPU)."""
    forced = os.environ.get("VC_PDF_PRIMARY", "").strip().lower()
    if forced in ("docling", "markitdown"):
        return forced
    return "docling" if accelerator_available() else "markitdown"


def pdf_open_check(path: Path) -> int:
    """Open the PDF with pypdf and return its page count; PdfDamagedError when
    it cannot be opened or has no pages. Measured on 1753 intact PDFs: zero
    false positives, page count identical to pypdfium2. Every truncated file
    raises PdfStreamError in the PdfReader constructor — docling-parse
    (#374) does not, and returns SUCCESS with pages missing. pypdf logs
    through `logging`, whose default handler writes to stderr, so nothing here
    can pollute the JSON-lines stdout."""
    try:
        from pypdf import PdfReader

        count = len(PdfReader(str(path)).pages)
    except Exception as err:  # noqa: BLE001 — any open failure means unusable
        raise PdfDamagedError(f"{type(err).__name__}: {err}") from err
    if count <= 0:
        raise PdfDamagedError("PDF sayfa içermiyor")
    return count


def expected_page_count(total: int, page_range: tuple[int, int] | None) -> int:
    """Pages a converter should return for `total` pages and an optional
    1-indexed inclusive page_range (docling's convention)."""
    if page_range is None:
        return total
    start, end = page_range
    return max(0, min(end, total) - start + 1)


def scope_page_numbers(total: int, page_range: tuple[int, int] | None) -> set[int]:
    """1-indexed page numbers a converter should return (see expected_page_count)."""
    if page_range is None:
        return set(range(1, total + 1))
    start, end = page_range
    return set(range(max(1, start), min(end, total) + 1))


def docling_page_numbers(results) -> set[int] | None:
    """Page numbers docling returned, or None when it exposes none (then the
    caller cannot tell which pages are missing and must treat a shortfall as
    damage). `result.pages` is a list of Page objects with `page_no`."""
    nums: set[int] = set()
    for r in results:
        for page in r.pages:
            n = getattr(page, "page_no", None)
            if not isinstance(n, int):
                return None
            nums.add(n)
    return nums


def classify_page_shortfall(
    expected: set[int], got: set[int] | None, image_only: set[int]
) -> tuple[str, list[int]]:
    """("damaged"|"scan", missing pages). "scan" only when every missing page is
    an image-only page; unknown page numbers or any missing page that is not
    image-only keeps the truncation verdict (docling-parse #374)."""
    if got is None:
        return "damaged", []
    missing = sorted(expected - got)
    if missing and all(m in image_only for m in missing):
        return "scan", missing
    return "damaged", missing


def looks_broken(text: str, page_count: int) -> bool:
    lines = [l for l in text.split("\n") if l.strip()]
    if not lines:
        return True
    short = sum(1 for l in lines if len(l.strip()) <= 2)
    if short / len(lines) > SHORT_LINE_RATIO_THRESHOLD:
        return True
    if page_count > MIN_PAGES_FOR_HEADING_CHECK and not any(l.startswith("#") for l in lines):
        return True
    # An unresolved font mapping. The extractor emits (cid:NN) for every glyph
    # it cannot map, which is most often exactly the math font — so the prose
    # survives, the equations do not, and nothing about the output looks wrong.
    if len(CID_ARTIFACT.findall(text)) > CID_ARTIFACT_THRESHOLD:
        return True
    return False


_H1_LINE = re.compile(r"^#[ \t]+(.+)$", re.MULTILINE)


def demote_slide_headings(text: str) -> str:
    """K2-7: MarkItDown emits every slide's own title as `# `, so a 29-slide
    deck came back with 29 top-level H1s (measured: Ayrık Sistemler slides.01
    — the chunker's own heading tree assumes one H1 per document, and this
    is what "başlık araması" upstream then has to guess a single title
    from). Every slide title becomes a `##` section instead; nothing is
    dropped, just demoted.

    Runs outside fenced code (_apply_outside_verbatim, postprocess.py) —
    unlikely in a pptx's own text (no native code-block shape in
    PowerPoint), but a slide can still legitimately show example code as
    plain text with its own `# ` comment, and that must never be read as a
    slide title."""
    return _apply_outside_verbatim(text, lambda chunk: _H1_LINE.sub(lambda m: f"## {m.group(1)}", chunk))


_SLIDE_MARKER = re.compile(r"^<!--\s*Slide number:\s*(\d+)\s*-->\s*$")
_NOTES_HEADING = re.compile(r"^#{1,6}[ \t]*Notes:?[ \t]*$")
_FENCE_LINE = re.compile(r"^\s*(```|~~~)")
# A repeated line must be on this share of slides AND on at least this many.
_BOILERPLATE_SHARE = 0.6
_BOILERPLATE_MIN_SLIDES = 4
_BOILERPLATE_MAX_CHARS = 200


def clean_pptx_noise(text: str) -> tuple[str, dict]:
    """Strips MarkItDown's PPTX-specific noise (measured on the Gradyan İniş
    deck): an empty `### Notes:` after every slide that merely has a notes
    slide, the bare slide-number line, and the footer repeated on every slide.

    Why the Notes heading matters beyond clutter: on a deck whose first slide
    has no title shape it was the FIRST heading of the whole document, so
    postprocess.fix_heading_jumps lifted `###` to `#` (previous level 0, so
    at most level 1): the note was titled "Notes:" and every later Notes
    heading cascaded to `##`, `###`. Non-empty notes keep their text under a
    plain bold label so they can never become a heading or the title.

    Fence-aware (a slide may show code as plain text) and marker-safe: the
    `<!-- Slide number: N -->` comments and images.py's `<!-- vc:... -->`
    tokens/markers are never touched. Returns (text, stats)."""
    stats = {"notes_removed": 0, "notes_relabeled": 0, "slide_numbers": 0, "footers": 0}
    lines = text.split("\n")
    # One entry per slide marker: (slide number, indexes of its lines).
    sections: list[tuple[int, list[int]]] = []
    in_fence = False
    for i, line in enumerate(lines):
        if _FENCE_LINE.match(line):
            in_fence = not in_fence
        m = None if in_fence else _SLIDE_MARKER.match(line)
        if m:
            sections.append((int(m.group(1)), [i]))
        elif sections:
            sections[-1][1].append(i)
    if not sections:  # no slide markers at all: not a MarkItDown deck
        return text, stats

    def next_to_number(idxs: list[int], i: int) -> bool:
        # A code listing's line-number gutter (1, 2, ... 24 as separate
        # lines, measured in slides.04) also contains the slide's own number;
        # a real slide-number box stands alone, so a bare-integer neighbour
        # means "content", not footer.
        pos = idxs.index(i)
        before = [lines[j].strip() for j in idxs[:pos] if lines[j].strip()]
        after = [lines[j].strip() for j in idxs[pos + 1 :] if lines[j].strip()]
        return bool((before and before[-1].isdigit()) or (after and after[0].isdigit()))

    drop: set[int] = set()
    replace: dict[int, str] = {}
    body_of: list[list[int]] = []  # per slide: candidate lines for the footer pass
    for number, idxs in sections:
        in_fence = False
        notes_at = None
        body: list[int] = []
        for i in idxs[1:]:  # idxs[0] is the marker comment itself
            line = lines[i]
            if _FENCE_LINE.match(line):
                in_fence = not in_fence
                continue
            if in_fence or notes_at is not None:
                continue
            if _NOTES_HEADING.match(line.strip()):
                notes_at = i
                continue
            if line.strip() == str(number) and not next_to_number(idxs, i):
                drop.add(i)
                stats["slide_numbers"] += 1
                continue
            body.append(i)
        body_of.append(body)
        if notes_at is not None:
            if any(lines[i].strip() for i in idxs if i > notes_at):
                replace[notes_at] = "**Konuşmacı notu:**"
                stats["notes_relabeled"] += 1
            else:
                drop.add(notes_at)
                stats["notes_removed"] += 1

    def boilerplate_candidate(line: str) -> str | None:
        t = line.strip()
        if not t or len(t) > _BOILERPLATE_MAX_CHARS:
            return None
        if t.startswith(("#", "<!--", "![", "|")):
            return None
        return t

    slide_count = len(body_of)
    if slide_count >= _BOILERPLATE_MIN_SLIDES:
        seen_in: dict[str, int] = {}
        for body in body_of:
            for t in {boilerplate_candidate(lines[i]) for i in body} - {None}:
                seen_in[t] = seen_in.get(t, 0) + 1
        repeated = {
            t
            for t, n in seen_in.items()
            if n >= _BOILERPLATE_MIN_SLIDES and n >= _BOILERPLATE_SHARE * slide_count
        }
        kept: set[str] = set()
        for body in body_of:
            for i in body:
                t = boilerplate_candidate(lines[i])
                if t in repeated:
                    if t in kept:
                        drop.add(i)
                        stats["footers"] += 1
                    else:
                        kept.add(t)  # first occurrence stays: the info is not lost

    out = [replace.get(i, line) for i, line in enumerate(lines) if i not in drop]
    return "\n".join(out), stats


def convert_with_markitdown(path: Path) -> str:
    from markitdown import MarkItDown

    # keep_data_uris makes MarkItDown hand over each PPTX/DOCX picture inline,
    # at its own position, instead of an unresolvable `Name.jpg` link / a
    # truncated data URI; images.py swaps them for tokens right away so the
    # base64 never reaches the post-processing regexes.
    collect = images.COLLECTOR.enabled and path.suffix.lower() in (".pptx", ".docx")
    if collect:
        images.COLLECTOR.candidates.clear()
        result = MarkItDown().convert(str(path), keep_data_uris=True)
    else:
        result = MarkItDown().convert(str(path))
    text = result.text_content
    if collect:
        text = images.tokenize_data_uri_images(text)
        if path.suffix.lower() == ".pptx":
            try:
                areas, slide_count = images.pptx_picture_areas(path)
                images.apply_pptx_areas(images.COLLECTOR.candidates, areas)
                images.COLLECTOR.total_pages = slide_count
            except Exception as err:  # noqa: BLE001 — without areas nothing is treated as template art
                print(f"images: slayt alanları okunamadı: {err}", file=sys.stderr)
    if path.suffix.lower() == ".pptx":
        text, _noise = clean_pptx_noise(text)
        text = demote_slide_headings(text)
    return text


def pandoc_bin() -> str:
    """Node (src/lib/server/pandoc-bin.ts, via convertQueue.ts) resolves
    PANDOC_BIN to an absolute pandoc.exe path and sets it on this process's
    env whenever the server process's own PATH is stale relative to a
    just-completed winget install — see that module's doc comment for why a
    bare 'pandoc' PATH lookup can keep failing for the rest of the server's
    lifetime otherwise. A direct CLI invocation of this script (the
    source-ingest skill doc's documented contract) sets no such env var, so
    this falls back to the bare command name, exactly like the old
    hardcoded "pandoc" did."""
    return os.environ.get("PANDOC_BIN") or "pandoc"


def pandoc_available() -> bool:
    return shutil.which(pandoc_bin()) is not None


def convert_with_pandoc(path: Path) -> str:
    proc = subprocess.run(
        [pandoc_bin(), "-f", "latex", "-t", "gfm", str(path)],
        capture_output=True, text=True, check=True
    )
    return proc.stdout


_HF_OFFLINE_CLASSES = ("LocalEntryNotFoundError", "OfflineModeIsEnabled")
_HF_OFFLINE_MARKERS = (
    "outgoing traffic has been disabled",
    "offline mode is enabled",
    "HF_HUB_OFFLINE",
    "couldn't connect to",
)


def _is_hf_offline_miss(err: BaseException) -> bool:
    """True when `err` (or anything in its cause/context chain) says a model
    was not in the local cache while offline mode was on. Verified against
    huggingface_hub 1.32 / transformers 5.17: snapshot_download raises
    LocalEntryNotFoundError ("...outgoing traffic has been disabled..."),
    a raw request raises OfflineModeIsEnabled, transformers raises OSError
    "We couldn't connect to ... and couldn't find them in the cached files".
    Matched by class name/message so huggingface_hub need not be importable."""
    seen: set[int] = set()
    cur: BaseException | None = err
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if any(c.__name__ in _HF_OFFLINE_CLASSES for c in type(cur).__mro__):
            return True
        text = str(cur)
        if any(m in text for m in _HF_OFFLINE_MARKERS):
            return True
        cur = cur.__cause__ or cur.__context__
    return False


def _set_hf_offline_constant(value: bool) -> None:
    """huggingface_hub reads HF_HUB_OFFLINE from the environment ONCE, at
    import, into huggingface_hub.constants.HF_HUB_OFFLINE (transformers 5.x
    imports is_offline_mode from it, so this is the only constant). When the
    package is already imported, changing os.environ alone does nothing."""
    mod = sys.modules.get("huggingface_hub.constants")
    if mod is not None:
        mod.HF_HUB_OFFLINE = value


def hf_offline_first(run: Callable[[], object]):
    """Run `run` with Hugging Face in offline mode; if it fails ONLY because a
    model is missing from the local cache, retry exactly once online.

    Why: docling loads its models via huggingface_hub.snapshot_download()
    without local_files_only, so every conversion process made requests to
    huggingface.co (a revision lookup per model) even with all weights cached
    — a privacy leak and a startup delay for a local-first app. Trade-off:
    docling model updates no longer arrive on their own; that is intended
    here. An explicit user-set HF_HUB_OFFLINE (either value) is respected and
    never retried."""
    if "HF_HUB_OFFLINE" in os.environ:
        return run()
    os.environ["HF_HUB_OFFLINE"] = "1"
    _set_hf_offline_constant(True)
    try:
        return run()
    except Exception as err:  # noqa: BLE001 — only the offline-miss case is handled
        if not _is_hf_offline_miss(err):
            raise
        print(
            "Modeller yerel önbellekte bulunamadı; Hugging Face'ten indiriliyor (yalnızca bir kez)...",
            file=sys.stderr,
        )
        os.environ.pop("HF_HUB_OFFLINE", None)
        _set_hf_offline_constant(False)
        return run()


def convert_with_marker(path: Path) -> str:
    """marker-pdf 2.x. Loads several hundred MB of model weights on first call,
    which is why it is an optional extra and why conversions are queued one at
    a time (the user's RAM belongs to Ollama first).

    A missing package must surface as ImportError so route_explicit/route_auto
    can turn it into the "not installed" message rather than a traceback.
    """
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict
    from marker.output import text_from_rendered

    def run() -> str:
        converter = PdfConverter(artifact_dict=create_model_dict())
        rendered = converter(str(path))
        text, _, _images = text_from_rendered(rendered)
        return text

    return hf_offline_first(run)


def pdf_has_text_layer(path: Path, sample_pages: int = 10) -> bool:
    """True when the PDF carries extractable text, i.e. it is born-digital.

    Decides whether OCR is needed. Sampling from the middle avoids judging a
    book by its cover page, which is often a scanned logo on an otherwise
    born-digital document.
    """
    try:
        from pypdf import PdfReader

        pages = PdfReader(str(path)).pages
        if not len(pages):
            return False
        start = max(0, len(pages) // 2 - sample_pages // 2)
        sample = pages[start : start + sample_pages]
        extracted = sum(len((p.extract_text() or "").strip()) for p in sample)
        return extracted > 200 * len(sample)
    except Exception:  # noqa: BLE001 — a heuristic input, not a result
        return False


# Pages whose docling reading order column_order.py repaired in the most recent
# convert_with_docling call; main() turns it into a warning. Module-level so
# the many call sites that return only the Markdown string stay unchanged.
_COLUMN_REPAIRED_PAGES: list[int] = []
# Same pattern for reading_order.py: pages whose order it repaired, and pages
# that still disagree with both independent references after the gate refused
# them (a warning only — the order is left as docling produced it).
_READING_REPAIRED_PAGES: list[int] = []
_READING_SUSPICIOUS_PAGES: list[int] = []
# docling's own error messages from the most recent PARTIAL_SUCCESS conversion
# (shortened); main() turns them into a warning. Same pattern as above.
_DOCLING_ERRORS: list[str] = []
# True when the most recent convert_with_docling call ran on the hybrid
# (fallback) backend — requested or switched to automatically. Same pattern.
_HYBRID_BACKEND_USED: list[bool] = [False]
# True when the most recent convert_with_docling call ran with OCR enabled;
# decides which textless-page warning main() shows. Same pattern as above.
_OCR_RAN: list[bool] = [False]
# OCR language plan (ocr_lang.OcrPlan) of the current run, resolved in main()
# from --ocr-lang / VC_OCR_LANG; None = engine default. Same pattern as above.
_OCR_PLAN: list["ocr_lang.OcrPlan | None"] = [None]
# formula_early_stop sayaçları (son docling dönüşümü); done olayına "formulaEarlyStop" olarak girer.
_FORMULA_STATS: list[dict | None] = [None]
# formula_crop sayaçları (son docling dönüşümü); done olayına "formulaCrop" olarak girer.
_FORMULA_CROP_STATS: list[dict | None] = [None]
# formula_fallback sayaçları (son docling dönüşümü); done olayına "formulaFallback" olarak girer.
_FORMULA_FALLBACK_STATS: list[dict | None] = [None]
# Why docling (the primary converter on a GPU machine) was skipped and
# MarkItDown/marker produced the text instead; main() turns it into a warning.
_PRIMARY_FALLBACK: list[str] = []


def reset_run_state() -> None:
    """Clear every per-run module global at the start of main(). The CLI runs
    main() once per process so this is a no-op there; the --serve worker runs
    many conversions in ONE process and a stale value from the previous file
    (a column-repair page list, a hybrid flag) would leak into the next file's
    warnings. _TEXTLESS_CACHE is only valid within one run (it is keyed by
    path/mtime/size) and would otherwise grow for the worker's whole life."""
    _COLUMN_REPAIRED_PAGES.clear()
    _READING_REPAIRED_PAGES.clear()
    _READING_SUSPICIOUS_PAGES.clear()
    _DOCLING_ERRORS.clear()
    _HYBRID_BACKEND_USED[0] = False
    _OCR_RAN[0] = False
    _OCR_PLAN[0] = None
    _FORMULA_STATS[0] = None
    _FORMULA_FALLBACK_STATS[0] = None
    formula_fallback.reset_images()
    _PRIMARY_FALLBACK.clear()
    _TEXTLESS_CACHE.clear()


# Serve mode keeps ONE docling DocumentConverter alive between conversions: its
# models (layout, tables, and above all the formula recognizer, ~20-45 s to
# load on the RTX 4050) are loaded once per worker instead of once per file.
# Only the CLI-per-file mode leaves this False and builds a converter per call.
_REUSE_CONVERTER: list[bool] = [False]
# At most ONE entry: a second converter (e.g. hybrid backend after a default
# one) would hold a second copy of the models in a 6 GB card, so a different
# key evicts the old converter first. Key = (hybrid backend, images enabled, OCR lang):
# those are the only inputs that change the pipeline options (see
# convert_with_docling) plus the OCR recognizer code (see ocr_lang); OCR
# on/off is toggled on the model, not part of the key.
_CONVERTER_CACHE: dict[tuple[bool, bool, str | None], object] = {}


def _release_cached_converters() -> None:
    _CONVERTER_CACHE.clear()
    try:
        import gc

        gc.collect()
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 — best-effort memory release
        pass


def _shared_converter(key: tuple[bool, bool, str | None], build: Callable[[], object]):
    """Return (converter, ocr_model) for `key`, building and caching it on a
    miss. ocr_model is the pipeline's OCR model whose `.enabled` flag is the
    per-document/segment toggle (see _convert_ocr_segments). Returns None when
    docling's internals do not allow it — the caller then builds an uncached
    converter exactly as the CLI does. Model-loading errors (offline cache
    miss, ...) are NOT swallowed here: they must reach hf_offline_first."""
    from docling.datamodel.base_models import InputFormat

    hit = _CONVERTER_CACHE.get(key)
    if hit is not None:
        return hit
    conv = build()
    get_pipeline = getattr(conv, "_get_pipeline", None)
    if get_pipeline is None:
        return None
    pipeline = get_pipeline(InputFormat.PDF)  # loads the models
    ocr_model = getattr(pipeline, "ocr_model", None)
    if ocr_model is None or not isinstance(getattr(ocr_model, "enabled", None), bool):
        return None
    if _CONVERTER_CACHE:
        _release_cached_converters()
    _CONVERTER_CACHE[key] = (conv, ocr_model)
    return conv, ocr_model


# Appended when OCR ran for a non-ASCII language and the note has a code fence.
OCR_CODE_NOTE = (
    "Taranmış sayfalardaki kod blokları OCR satır kutularından yeniden kuruldu (kod tanıma Türkçe vb. "
    "karakterleri bozuyor); girinti ve satır sonları yaklaşık olabilir, kodu gözden geçirin."
)

PDF_BACKENDS = ("default", "hybrid")
HYBRID_BACKEND_WARNING = (
    "Yedek PDF okuyucusuyla dönüştürüldü; resim içindeki metinler ve bazı formüller eksik olabilir, gözden geçirin."
)


def _is_open_failure(err: BaseException) -> bool:
    """True for docling's ConversionError saying it could not open the
    document — the only visible symptom of docling-parse#354 (the real cause,
    a filesystem error from the renderer on a non-ASCII profile path, is only
    in the log). Matched by class name and message so this works without
    importing docling. A truncated/corrupt PDF would produce the same symptom,
    but pdf_open_check already rejects those before any converter runs."""
    is_conversion_error = any(c.__name__ == "ConversionError" for c in type(err).__mro__)
    return is_conversion_error and "while opening the document" in str(err)


def ocr_segments(page_range: tuple[int, int], textless: set[int] | list[int]) -> list[tuple[int, int, bool]]:
    """Split `page_range` (1-indexed, inclusive) into contiguous runs of
    (start, end, needs_ocr): a run of textless pages gets OCR, the runs between
    them do not. Textless pages outside the range are ignored.

    Why: docling's default OCR mode runs on every layout region not covered by
    PDF text cells (pictures included), so enabling OCR for the whole document
    because ONE page is a scan is very slow. Measured 2026-10-08 on a 12-page
    German story book whose only scanned page was the cover: 57 s with
    whole-document OCR, 1.5 s without, 9.4 s for OCR on page 1 alone; segmented
    (OCR page 1, none for 2-12) 5.3 s. Across the 702-PDF corpus, 64 mixed PDFs
    / 13,747 pages, whole-document OCR was estimated to waste ~18 h."""
    start, end = page_range
    if end < start:
        return []
    tl = set(textless)
    out: list[tuple[int, int, bool]] = []
    cur, cur_ocr = start, start in tl
    for p in range(start + 1, end + 1):
        if (p in tl) != cur_ocr:
            out.append((cur, p - 1, cur_ocr))
            cur, cur_ocr = p, p in tl
    out.append((cur, end, cur_ocr))
    return out


# Long PDFs are converted in page chunks of at most this size (#83, measured
# 2026-10-15 on a 1151-page book, docs/dev/bellek-olcum-2026-10-15.md): with
# formula/code enrichment and picture crops on, docling keeps every page's
# image, PDF backend and parsed cells until the whole conversion ends — RAM
# grew as ~2.4 GB + 20 MB/page (150 pages 5.5 GB, 600 pages 14.6 GB), so a
# 32 GB machine ran out above ~1300 pages. Chunks bound the peak to one
# chunk's pages. VC_PDF_CHUNK_PAGES overrides it (tests, small machines).
PDF_CHUNK_PAGES = 150


def pdf_chunk_pages() -> int:
    raw = os.environ.get("VC_PDF_CHUNK_PAGES", "").strip()
    try:
        n = int(raw) if raw else PDF_CHUNK_PAGES
    except ValueError:
        n = PDF_CHUNK_PAGES
    return max(1, n)


def chunk_segments(segments: list[tuple[int, int, bool]], size: int) -> list[tuple[int, int, bool]]:
    """Split every (start, end, ocr) segment longer than `size` pages into
    consecutive pieces of at most `size` pages, keeping its OCR flag."""
    out: list[tuple[int, int, bool]] = []
    for start, end, ocr in segments:
        while end - start + 1 > size:
            out.append((start, start + size - 1, ocr))
            start += size
        out.append((start, end, ocr))
    return out


def _release_pages(result) -> None:
    """Drop what docling keeps per page for enrichment (page image, PDF
    backend, parsed cells) once a chunk is fully processed; the Page objects
    and their page_no stay for the page-count checks. Best-effort."""
    for page in getattr(result, "pages", None) or []:
        try:
            backend = getattr(page, "_backend", None)
            if backend is not None:
                backend.unload()
                page._backend = None
            page._image_cache = {}
            page.parsed_page = None
        except Exception:  # noqa: BLE001 — memory only, never the conversion
            pass


def _concatenate_keep_pages(documents):
    """DoclingDocument.concatenate shifts each document's pages to follow the
    previous document's LAST page; when docling dropped the last page(s) of a
    chunk, every later page number would move down. Map the merged pages back
    to the page numbers the chunks actually had (order is preserved)."""
    from docling_core.types.doc import ContentLayer, DocItem, DoclingDocument

    merged = DoclingDocument.concatenate(documents)
    original = sorted(p for d in documents for p in d.pages)
    current = sorted(merged.pages)
    if original == current or len(original) != len(current):
        return merged
    mapping = dict(zip(current, original))
    merged.pages = {mapping[n]: page for n, page in merged.pages.items()}
    for n, page in merged.pages.items():
        page.page_no = n
    for item, _level in merged.iterate_items(traverse_pictures=True, included_content_layers=set(ContentLayer)):
        if isinstance(item, DocItem):
            for prov in item.prov:
                prov.page_no = mapping.get(prov.page_no, prov.page_no)
    return merged


def _code_formula_model(conv):
    """The pipeline's CodeFormula enrichment model (None when docling's
    internals differ). Its `options.extract_code` can be flipped per run."""
    try:
        from docling.datamodel.base_models import InputFormat

        for model in conv._get_pipeline(InputFormat.PDF).enrichment_pipe:
            opts = getattr(model, "options", None)
            if opts is not None and isinstance(getattr(opts, "extract_code", None), bool):
                return model
    except Exception:  # noqa: BLE001 — quality tweak only
        pass
    return None


def _set_code_extraction(conv, on: bool) -> None:
    """Turn CodeFormula's CODE recognition on/off for the next conversion
    (formula recognition is untouched).

    Why off for OCR'd pages (#8, measured 2026-10-13 on fonk1-NOTLU.pdf, a
    scanned Turkish Python lesson): RapidOCR PP-OCRv6 reads "Geri döndürülen
    parçaları" correctly, then CodeFormulaV2 re-reads the code-labelled region
    from pixels and overwrites it with "d&ndurilen pargalari" — it was never
    trained on Turkish diacritics. It is off for OCR'd pages in EVERY language
    (it also corrupts plain ASCII on scans); code_layout then rebuilds the
    layout from the OCR boxes. Born-digital code keeps CodeFormula (its
    text comes from the PDF layer, and the model fixes indentation)."""
    model = _code_formula_model(conv)
    if model is not None:
        model.options.extract_code = on


def _disable_ocr_cls(conv) -> None:
    """RapidOCR's text-angle classifier flips long, wide code lines upside down
    (measured on fonk1, #8): switch it off on the OCR engine behind the auto
    model (the explicit-language branch sets use_cls=False in its options)."""
    try:
        from docling.datamodel.base_models import InputFormat

        ocr_model = conv._get_pipeline(InputFormat.PDF).ocr_model
        engine = getattr(ocr_model, "_engine", None) or ocr_model
        opts = getattr(engine, "options", None)
        if opts is not None and isinstance(getattr(opts, "use_cls", None), bool):
            opts.use_cls = False
    except Exception:  # noqa: BLE001 — quality tweak only
        pass


def _rebuild_scanned_code(result) -> None:
    """Rebuild code-block layout of an OCR'd conversion result from its OCR
    line boxes (code_layout). Any failure keeps today's (collapsed) text."""
    try:
        n = code_layout.rebuild_code_items(result.document, result.pages)
        if n:
            print(f"code_layout: {n} kod bloğu OCR kutularından yeniden kuruldu", file=sys.stderr)
    except Exception as err:  # noqa: BLE001
        print(f"code_layout: atlandı: {err}", file=sys.stderr)


def _convert_ocr_segments(conv, path: Path, segments: list[tuple[int, int, bool]]):
    """Convert each (start, end, ocr) segment on the SAME DocumentConverter,
    toggling the pipeline's OCR model between them, and concatenate the
    segment documents. Segments are OCR runs (ocr_segments) and/or page
    chunks of a long PDF (chunk_segments); each segment's page resources are
    released as soon as it is done. Returns (results, merged_document,
    ocr_ran), or None when docling's internals do not allow it (the caller
    then converts the whole document in one call, as before). A conversion
    error from docling itself is NOT swallowed — only the optimization is
    best-effort."""
    from docling.datamodel.base_models import InputFormat

    try:
        ocr_model = conv._get_pipeline(InputFormat.PDF).ocr_model
        if not isinstance(ocr_model.enabled, bool):
            raise AttributeError("ocr_model.enabled")
        from docling_core.types.doc import DoclingDocument  # noqa: F401 — availability check
    except Exception as err:  # noqa: BLE001 — optimization only
        print(f"docling: parçalı dönüştürme kullanılamadı, belge tek seferde çevriliyor: {err}", file=sys.stderr)
        return None
    was_enabled = ocr_model.enabled
    total = sum(e - s + 1 for s, e, _o in segments)
    done = 0
    results = []
    try:
        for start, end, ocr in segments:
            ocr_model.enabled = ocr
            _set_code_extraction(conv, not ocr)
            result = conv.convert(str(path), page_range=(start, end))
            if ocr:
                _rebuild_scanned_code(result)
            _release_pages(result)
            results.append(result)
            done += end - start + 1
            emit({"type": "progress", "stage": "converting", "pagesDone": done, "pagesTotal": total})
    finally:
        # Back to the converter's own setting: a CLI converter built with
        # do_ocr=False has no OCR engine to switch on.
        ocr_model.enabled = was_enabled
        _set_code_extraction(conv, True)
    try:
        document = _concatenate_keep_pages([r.document for r in results])
    except Exception as err:  # noqa: BLE001 — optimization only
        print(f"docling: parçalı dönüştürme kullanılamadı, belge tek seferde çevriliyor: {err}", file=sys.stderr)
        return None
    return results, document, any(ocr for _s, _e, ocr in segments)


def convert_with_docling(
    path: Path, page_range: tuple[int, int] | None = None, backend: str = "default"
) -> str:
    """docling 2.x — preferred over marker when the document's value is in its
    tables, and the only one of the two that works on Windows (see
    escalate_pdf). Same optional-extra and ImportError contract as marker.

    The defaults are wrong for this app and all three overrides were measured
    on Trentelman's 404-page control theory book:

    - `do_formula_enrichment` is off by default, and without it docling detects
      every display equation and decodes none: the first run produced 1239
      `<!-- formula-not-decoded -->` placeholders and zero LaTeX. Good prose
      with holes where the mathematics was is worse than a failed conversion,
      because it looks complete. Measured limitation, not fixed by this app
      (Aşama 7, 2026-09-23): the recognizer sometimes emits a bare operator
      name as space-joined single-character tokens outside `\\text{}` (e.g.
      `A t t e n t i o n` for "Attention") rather than one word, and can
      misread a technical subscript outright (`d_model` came back
      `d_\\minodl` on a real arXiv PDF) — inherent to the recognition model,
      not something a regex here can safely correct without risking
      over-correcting genuine multi-variable products (`a b c` meaning
      a·b·c). Equation-heavy docling imports are worth a manual spot-check.
    - `do_code_enrichment` is off by default, which matters for the CS and ML
      sources in this library.
    - `do_ocr` is on by default. That book is born-digital, so all 404 pages
      were OCR'd for nothing — on CPU, because onnxruntime-gpu did not match
      the installed CUDA. OCR now runs only where it is needed: on every page
      when the sampled middle pages have no text layer, otherwise only on the
      image-only pages (textless_pages_in_scope). The sample alone missed a
      mostly born-digital PDF with a few scanned pages — those came back
      silently empty. Per-page OCR (2026-10-08): enabling OCR for the whole
      document because one page is a scan took 57 s vs 5.3 s for a 12-page
      book (see ocr_segments). The textless runs are converted as separate
      page-range segments on ONE DocumentConverter (the formula model takes
      ~45 s to load), toggling the pipeline's OCR model between segments, and
      the segment documents are concatenated. If docling's internals do not
      allow that, the whole document is OCR'd as before.

    Device (Aşama 7, 2026-09-23, measured on an RTX 4050 6GB against an
    8-page arXiv paper and a 12-page OSTEP chapter): CPU is categorically
    unusable — 79 s/page and 23 s/page respectively (635s/271s total), while
    GPU does the same documents in 3.4 s/page and 2.6 s/page (27s/32s) even
    with nothing else loaded. GPU with qwen3:8b already resident is slower
    still (8.8 s/page and 7.5 s/page — contention roughly triples docling's
    own time) and knocks concurrent chat decode down from an 11.8 tok/s
    baseline to 5–10 tok/s, but chat keeps generating throughout (same-model
    leases never touch sharedJobMutex — see ollama-gate.ts — so nothing
    blocks, only slows). VRAM peaked at ~5.9 of 6.1 GB in that contended
    case: tight, but it held across both runs without OOMing. CPU's 20–30x
    slowdown is a far worse outcome than GPU's 2–3x slowdown under
    contention, so `AUTO` (not a hardcoded CPU fallback) is kept explicit
    here — it already resolves to CUDA on this machine, and degrades
    gracefully to CPU on a GPU-less one instead of hard-failing.

    page_range (#37, Aşama 7): 1-indexed inclusive, docling's own convention
    — for a document too large to convert whole in one sitting. Independent
    of it, a scope longer than pdf_chunk_pages() is converted in chunks on
    the same converter and merged (#83, see PDF_CHUNK_PAGES).

    backend: "default" or "hybrid" (see hybrid_backend.py and the module
    docstring's --pdf-backend). On "default", an open failure (#354) is
    retried once on "hybrid"; every other error propagates unchanged.
    """
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import AcceleratorDevice, AcceleratorOptions, PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    _OCR_RAN[0] = False
    try:
        formula_early_stop.install()
        formula_early_stop.reset_stats()
        import formula_graph_decode

        formula_graph_decode.reset_stats()
    except Exception as err:  # noqa: BLE001 — hızlandırma; dönüşümü asla bozmaz
        print(f"formula_early_stop: kurulamadı: {err}", file=sys.stderr)
    try:
        formula_crop.install()
        formula_crop.reset_stats()
    except Exception as err:  # noqa: BLE001 — kalite iyileştirmesi; dönüşümü asla bozmaz
        print(f"formula_crop: kurulamadı: {err}", file=sys.stderr)
    try:
        # formula_crop.install()'dan SONRA: crop kancasının ürettiği kırpımı saklar (MinerU yedeği için)
        formula_fallback.install()
        formula_fallback.reset_stats()
    except Exception as err:  # noqa: BLE001 — kalite iyileştirmesi; dönüşümü asla bozmaz
        print(f"formula_fallback: kurulamadı: {err}", file=sys.stderr)
    options = PdfPipelineOptions()
    need_all = not pdf_has_text_layer(path)
    textless = [] if need_all else textless_pages_in_scope(path, page_range)
    total_pages = pdf_page_count(path)
    scope = page_range or ((1, total_pages) if total_pages > 0 else None)
    # More than one segment = a mix of scanned and born-digital pages and/or
    # a PDF longer than one chunk (pdf_chunk_pages); an unknown page count
    # (scope None) keeps the old single whole-document call.
    if scope is None:
        segments = []
    elif need_all:
        segments = [(scope[0], scope[1], True)]
    else:
        segments = ocr_segments(scope, textless)
    segments = chunk_segments(segments, pdf_chunk_pages())
    per_page = len(segments) > 1
    want_ocr = need_all or bool(textless)
    # Serve mode: the cached converter is always built with OCR on and the
    # OCR model is switched off per document/segment instead (ONE pipeline,
    # ONE copy of the models); a converter with do_ocr=False would be a second
    # pipeline. The CLI keeps building exactly the pipeline it needs.
    options.do_ocr = True if _REUSE_CONVERTER[0] else want_ocr
    _OCR_RAN[0] = want_ocr
    plan = _OCR_PLAN[0]
    ocr_code = plan.lang if plan is not None else None
    options.generate_parsed_pages = True  # page cells (boxes) for code_layout
    if ocr_code:
        # Explicit recognizer (ocr_lang.resolve only returns codes the INSTALLED
        # models serve, so this never triggers a model download).
        from docling.datamodel.pipeline_options import RapidOcrOptions

        options.ocr_options = RapidOcrOptions(lang=[ocr_code], use_cls=False)
    options.do_formula_enrichment = True
    options.do_code_enrichment = True
    options.accelerator_options = AcceleratorOptions(device=AcceleratorDevice.AUTO)
    if images.COLLECTOR.enabled:
        # Crops of the detected pictures; 2.0 keeps small-print screenshots
        # legible (measured cost: see the images.py commit notes / SKILL.md).
        options.generate_picture_images = True
        options.images_scale = 2.0
        images.COLLECTOR.candidates.clear()

    convert_kwargs = {"page_range": page_range} if page_range else {}

    def run_once(use_hybrid: bool):
        if use_hybrid:
            # Imported here: it needs docling, which is optional.
            from hybrid_backend import HybridDoclingParseBackend

            fmt = PdfFormatOption(pipeline_options=options, backend=HybridDoclingParseBackend)
        else:
            fmt = PdfFormatOption(pipeline_options=options)
        def build():
            return DocumentConverter(format_options={InputFormat.PDF: fmt})

        ocr_model = None
        conv = None
        if _REUSE_CONVERTER[0]:
            shared = _shared_converter((use_hybrid, images.COLLECTOR.enabled, ocr_code), build)
            if shared is not None:
                conv, ocr_model = shared
            else:
                # Toggle internals unavailable: behave like the CLI (own
                # converter with exactly the OCR setting this file needs).
                options.do_ocr = want_ocr
        if conv is None:
            conv = build()
        if want_ocr:
            _disable_ocr_cls(conv)
        if per_page:
            # (results, document, ocr_ran), or None when the per-page route is
            # unavailable and the whole document must be OCR'd.
            seg_run = _convert_ocr_segments(conv, path, segments)
            if seg_run is not None:
                return seg_run
        try:
            if ocr_model is not None:
                ocr_model.enabled = want_ocr
            _set_code_extraction(conv, not want_ocr)
            result = conv.convert(str(path), **convert_kwargs)
            if want_ocr:
                _rebuild_scanned_code(result)
        finally:
            if ocr_model is not None:
                ocr_model.enabled = True
            _set_code_extraction(conv, True)
        return [result], result.document, want_ocr

    def run(use_hybrid: bool):
        # Model loading happens inside .convert(), so the offline-first retry
        # wraps exactly this call (see hf_offline_first).
        return hf_offline_first(lambda: run_once(use_hybrid))

    use_hybrid = backend == "hybrid"
    _HYBRID_BACKEND_USED[0] = False
    try:
        results, document, ocr_ran = run(use_hybrid)
    except Exception as err:  # noqa: BLE001 — only the open failure is handled
        if use_hybrid or not _is_open_failure(err):
            raise
        print(
            "docling: belge açılamadı (docling-parse #354 olabilir); yedek PDF okuyucusuyla yeniden deneniyor",
            file=sys.stderr,
        )
        use_hybrid = True
        results, document, ocr_ran = run(True)
    _HYBRID_BACKEND_USED[0] = use_hybrid
    _OCR_RAN[0] = ocr_ran
    try:
        _FORMULA_STATS[0] = formula_early_stop.report()
    except Exception:  # noqa: BLE001
        _FORMULA_STATS[0] = None
    try:
        import formula_graph_decode

        formula_graph_decode.report()
    except Exception:  # noqa: BLE001
        pass
    try:
        _FORMULA_CROP_STATS[0] = formula_crop.report()
    except Exception:  # noqa: BLE001
        _FORMULA_CROP_STATS[0] = None
    # CodeFormula'nın boş/döngülü/geçersiz LaTeX'ini MinerU ile yeniden oku (CUDA yoksa atlanır; modeli
    # işi bitince boşaltır). Sütun/okuma sırası onarımından ve markdown dışa aktarımından ÖNCE: sonraki
    # adımlar düzeltilmiş metni görür. Hata dönüşümü bozmaz (CodeFormula metni kalır).
    try:
        # CUDA grafikli formül decode'unun K/V deposu ve grafikleri MinerU yüklenmeden bırakılır.
        import formula_graph_decode

        formula_graph_decode.release()
    except Exception:  # noqa: BLE001
        pass
    try:
        formula_fallback.apply(document)
        _FORMULA_FALLBACK_STATS[0] = formula_fallback.report()
    except Exception as err:  # noqa: BLE001
        print(f"formula_fallback: atlandı: {err}", file=sys.stderr)
        _FORMULA_FALLBACK_STATS[0] = None
    # docling-parse (#374) returns SUCCESS with an empty error list for a
    # truncated PDF, just with pages missing — so the status is no evidence;
    # compare the page count against what the file itself says it has.
    got = sum(len(r.pages) for r in results)
    expected = expected_page_count(total_pages, page_range)
    shortfall_note: str | None = None
    if expected > 0 and got < expected:
        # main() already proved the file opens (pdf_open_check), so a shortfall
        # is only "damaged" when the missing pages could have carried text. A
        # page that is an image-only scan and that docling dropped is an OCR /
        # pipeline failure on that page, not a truncated file (2026-10-10: a
        # 34-page scan was reported PDF_DAMAGED although pypdf opened it).
        kind, missing = classify_page_shortfall(
            scope_page_numbers(total_pages, page_range),
            docling_page_numbers(results),
            set(textless_pages(path)),
        )
        if kind == "damaged":
            raise PdfDamagedError(f"docling {got}/{expected} sayfa döndürdü")
        if got == 0:
            raise RuntimeError(
                f"docling taranmış PDF'den hiç sayfa döndürmedi (OCR başarısız olmuş olabilir); "
                f"sayfa {_page_list(missing)}"
            )
        shortfall_note = (
            f"{len(missing)} taranmış sayfa dönüştürülemedi (sayfa {_page_list(missing)}): "
            "bu sayfaların içeriği notta eksik."
        )
    # PARTIAL_SUCCESS (some pages reported errors) is kept: the pages that did
    # convert are real content; the errors become a warning instead.
    _DOCLING_ERRORS.clear()
    if shortfall_note:
        _DOCLING_ERRORS.append(shortfall_note)
    partial = False
    for result in results:
        if str(getattr(result.status, "name", result.status)) != "PARTIAL_SUCCESS":
            continue
        partial = True
        for item in getattr(result, "errors", None) or []:
            msg = str(getattr(item, "error_message", item)).strip()
            if msg:
                _DOCLING_ERRORS.append(msg[:200])
    if partial and not _DOCLING_ERRORS:
        _DOCLING_ERRORS.append("ayrıntı bildirilmedi")
    # docling's reading-order pass sometimes swaps the columns of a two-column
    # page although every bbox is right (column_order.py). A failure here must
    # never fail the conversion: fall back to docling's own order.
    _COLUMN_REPAIRED_PAGES.clear()
    try:
        _COLUMN_REPAIRED_PAGES.extend(repair_document_order(document))
    except Exception as err:  # noqa: BLE001 — repair is best-effort
        print(f"column_order: onarım atlandı: {err}", file=sys.stderr)
    # Short left-aligned lines between centred display formulas get sorted
    # after unrelated blocks (reading_order.py). `path` is the file docling
    # actually read (the TeX-patched copy when there is one), so its text
    # stream matches docling's page geometry. Best-effort like the pass above.
    _READING_REPAIRED_PAGES.clear()
    _READING_SUSPICIOUS_PAGES.clear()
    try:
        repaired, suspicious = repair_reading_order(document, path)
        _READING_REPAIRED_PAGES.extend(repaired)
        _READING_SUSPICIOUS_PAGES.extend(suspicious)
    except Exception as err:  # noqa: BLE001 — repair is best-effort
        print(f"reading_order: onarım atlandı: {err}", file=sys.stderr)
    if images.COLLECTOR.enabled:
        try:
            md = images.docling_markdown_with_tokens(document)
            images.COLLECTOR.total_pages = len(document.pages) or None
            return md
        except Exception as err:  # noqa: BLE001 — images are best-effort, the text is not
            print(f"images: görsel çıkarma atlandı: {err}", file=sys.stderr)
            images.COLLECTOR.candidates.clear()
    return document.export_to_markdown()


def not_installed_message(tool: str) -> str:
    return f"Bu araç kurulu değil: pip install {tool}"


def pandoc_not_installed_message() -> str:
    return "Bu araç kurulu değil: pandoc bir sistem paketi, pip install ile kurulmaz — https://pandoc.org/installing.html"


def convert_code_file(path: Path) -> str:
    """Kod dosyaları, Seçenek B (Aşama 11): the file already IS the content —
    wrapped as one fenced Markdown block, nothing to convert. No `# filename`
    heading is added here; main()'s existing title_fallback (from
    --source-name) already derives a title the same way it does for any
    other headingless conversion (a raw MarkItDown PDF pass, an already-
    Markdown upload with no H1), so this doesn't need its own copy of that
    logic.

    Fence width widens past the longest backtick run already inside the
    source (rare — a fenced snippet embedded in a docstring/comment) so the
    wrapper can never be closed early by the file's own content.
    """
    lang = CODE_EXTENSIONS[path.suffix.lower()]
    code = path.read_text(encoding="utf-8", errors="replace")
    longest_run = max((len(m) for m in re.findall(r"`+", code)), default=0)
    fence = "`" * max(3, longest_run + 1)
    return f"{fence}{lang}\n{code}\n{fence}\n"


def route_auto(
    path: Path, page_range: tuple[int, int] | None = None, pdf_backend: str = "default"
) -> tuple[str, str]:
    """Returns (markdown_text, converted_by). page_range (#37) only ever
    restricts the docling path below — MarkItDown's pass is fast enough on a
    huge document that there's nothing to save by partial-converting it too,
    and MarkItDown has no partial-page mode to give it anyway.

    PDF order (2026-10-07, 5 real PDFs): docling was clearly better on every
    one (headings, LaTeX display math, no junk tables) while MarkItDown
    produced pipe tables that were 62% empty cells (18-page two-column paper)
    and 63% (3-page math review), U+FFFD glyphs, and — for PDFs of <= 5 pages —
    was never escalated (looks_broken skips the heading check there). A 2-page
    PDF whose page 2 was a scanned image came back as the cover alone with no
    warning. So when pdf_primary_tool() == "docling" (a GPU is present:
    7-24 s for short PDFs, ~3.4 s/page; CPU is 23-79 s/page) docling runs
    first and MarkItDown (then marker) is only the fallback if docling is
    missing or fails — recorded in _PRIMARY_FALLBACK for a warning.
    Otherwise MarkItDown runs first and escalates when looks_broken() fires
    or any page has no text layer (textless_pages)."""
    ext = path.suffix.lower()

    if ext in CODE_EXTENSIONS:
        return convert_code_file(path), "code-wrap"

    if ext == TEX_EXT:
        if pandoc_available():
            return convert_with_pandoc(path), "pandoc"
        raise RuntimeError(pandoc_not_installed_message())

    if ext in MARKITDOWN_EXTS:
        return convert_with_markitdown(path), "markitdown"

    if ext == MD_EXT:
        # Ö6: already Markdown — no conversion tool has anything to do here.
        # Any pre-existing frontmatter is split off in main() before
        # postprocess() runs, so its YAML isn't mistaken for body text.
        return path.read_text(encoding="utf-8", errors="replace"), "already-markdown"

    if ext == PDF_EXT:
        _PRIMARY_FALLBACK.clear()
        skip: tuple[str, ...] = ()
        if pdf_primary_tool() == "docling":
            try:
                return convert_with_docling(path, page_range=page_range, backend=pdf_backend), "docling"
            except PdfDamagedError:
                raise
            except ImportError:
                _PRIMARY_FALLBACK.append("kurulu değil")
            except Exception as err:  # noqa: BLE001 — reported as a warning, MarkItDown follows
                msg = str(err).strip()
                _PRIMARY_FALLBACK.append(msg.splitlines()[0][:150] if msg else type(err).__name__)
            skip = ("docling",)  # already failed: do not retry it in escalate_pdf
        text = convert_with_markitdown(path)
        page_count = pdf_page_count(path) or text.count("\f") + 1
        # A page with no text layer is invisible to looks_broken(): the other
        # pages carry the text it judges (2-page PDF, page 2 scanned).
        if looks_broken(text, page_count) or textless_pages_in_scope(path, page_range):
            try:
                return escalate_pdf(path, page_range=page_range, pdf_backend=pdf_backend, skip=skip)
            except RuntimeError as err:
                if len(text.strip()) >= MIN_FALLBACK_CHARS:
                    # S9: looks_broken() can be a false positive — a dense,
                    # multi-column or figure-heavy layout with a real text
                    # layer gets flagged as "looks scanned" the same way a
                    # genuinely scanned page does. When escalation is
                    # unavailable or fails, losing real extracted text
                    # outright is worse than a flagged, lower-confidence
                    # MarkItDown pass (needs_review is already forced for
                    # every unescalated PDF pass below). A near-empty
                    # extraction has nothing worth salvaging, so it still
                    # raises.
                    return text, "markitdown"
                if skip:
                    raise RuntimeError(f"docling: {'; '.join(_PRIMARY_FALLBACK)}; {err}") from err
                raise
        return text, "markitdown"

    raise RuntimeError(f"Desteklenmeyen dosya türü: {ext}")


def escalate_pdf(
    path: Path,
    page_range: tuple[int, int] | None = None,
    pdf_backend: str = "default",
    skip: tuple[str, ...] = (),
) -> tuple[str, str]:
    """Marker first, then Docling, then a clean error naming why each failed.
    Used when MarkItDown ran first (CPU-only machines, VC_PDF_PRIMARY=markitdown)
    or when the primary docling attempt already failed — then route_auto passes
    skip=("docling",) so docling is not retried here.

    Trying both is not belt-and-braces. An installed converter can fail at
    conversion time rather than import time, and for a platform reason that has
    nothing to do with this PDF: marker 2.x drives surya, which routes to a
    vLLM backend whenever it sees an NVIDIA GPU and spawns it as a subprocess.
    vLLM has no Windows build, so on a Windows box with a GPU marker raises
    OSError (WinError 193) on every document. Docling runs torch in-process and
    is unaffected — falling through to it is the difference between "this
    machine cannot convert math-heavy PDFs" and "it can".

    Both failures are reported, so a genuinely broken install still looks
    broken rather than silently degrading. page_range (#37) only reaches
    docling — marker has no equivalent option, and in practice never gets
    this far on Windows anyway (see above).
    """
    reasons: list[str] = []
    attempts: list[tuple[str, Callable[[], str]]] = [
        ("marker", lambda: convert_with_marker(path)),
        ("docling", lambda: convert_with_docling(path, page_range=page_range, backend=pdf_backend)),
    ]
    for name, convert in attempts:
        if name in skip:
            continue
        try:
            return convert(), name
        except ImportError:
            reasons.append(f"{name}: kurulu değil")
        except PdfDamagedError:
            raise
        except Exception as err:  # noqa: BLE001 — reported, not swallowed
            reasons.append(f"{name}: {err}")

    raise RuntimeError(
        "Bu PDF karmaşık/taranmış görünüyor ve gelişmiş bir dönüştürücü "
        "gerektiriyor, ama hiçbiri çalışmadı — " + "; ".join(reasons)
    )


def route_explicit(
    path: Path, tool: str, page_range: tuple[int, int] | None = None, pdf_backend: str = "default"
) -> tuple[str, str]:
    try:
        if tool == "markitdown":
            return convert_with_markitdown(path), "markitdown"
        if tool == "marker":
            return convert_with_marker(path), "marker"
        if tool == "docling":
            return convert_with_docling(path, page_range=page_range, backend=pdf_backend), "docling"
        if tool == "pandoc":
            if not pandoc_available():
                raise RuntimeError(pandoc_not_installed_message())
            return convert_with_pandoc(path), "pandoc"
    except ImportError:
        raise RuntimeError(not_installed_message(tool))
    raise RuntimeError(f"Bilinmeyen araç: {tool}")


_EXISTING_FRONTMATTER = re.compile(r"^---\n(.*?)\n---\n?", re.DOTALL)


def split_existing_frontmatter(text: str) -> tuple[dict, str]:
    """Ö6: a directly-uploaded .md may already carry its own frontmatter (a
    prior vault-chat export re-imported, an Obsidian note) — postprocess()
    must not run its HTML-stripping/math-wrapping passes over that YAML
    block, and an existing title there should win over guessing one. Only
    `title` is ever read back out; the rest is discarded rather than
    merged into the output frontmatter (domain/level/converted_by are the
    Node confirm step's to set, per build_frontmatter's contract, not a
    re-imported file's own say-so)."""
    m = _EXISTING_FRONTMATTER.match(text)
    if not m:
        return {}, text
    meta: dict = {}
    for line in m.group(1).split("\n"):
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        value = value.strip()
        try:
            value = json.loads(value)
        except (json.JSONDecodeError, ValueError):
            pass
        meta[key.strip()] = value
    return meta, text[m.end() :]


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def unique_output_path(out_dir: Path, stem: str) -> Path:
    """K2: convert.py used to always write `<stem>.md`, silently overwriting
    whatever was already there — a real risk once source_sha256 makes
    re-imports of a changed source routine (E5) rather than a rare manual
    re-run. A numeric suffix is appended instead of overwriting; the first
    free name wins, `<stem>.md` itself if nothing is there yet."""
    candidate = out_dir / f"{stem}.md"
    n = 2
    while candidate.exists():
        candidate = out_dir / f"{stem}-{n}.md"
        n += 1
    return candidate


def parse_page_range(raw: str) -> tuple[int, int]:
    """--pages START-END (#37), 1-indexed inclusive — docling's own
    page_range convention, so the value round-trips straight through with
    no reindexing."""
    m = re.fullmatch(r"(\d+)-(\d+)", raw)
    if not m:
        raise ValueError(f"--pages biçimi START-END olmalı, alınan: {raw!r}")
    start, end = int(m.group(1)), int(m.group(2))
    if start < 1 or end < start:
        raise ValueError(f"--pages geçersiz aralık: {raw!r}")
    return start, end


def textless_warning(converted_by: str, textless: list[int], ocr_ran: bool) -> str | None:
    """Warning for image-only pages. "OCR ile okundu" is only true when docling
    ran with OCR on; a docling run without OCR (or MarkItDown) left them empty."""
    if not textless:
        return None
    if converted_by == "docling" and ocr_ran:
        return (
            f"{len(textless)} sayfa OCR ile okundu (sayfa {_page_list(textless)}): "
            "el yazısı veya taramada metin ve formüller hatalı olabilir, kaynakla karşılaştırın."
        )
    if converted_by in ("markitdown", "docling"):
        return (
            f"{len(textless)} sayfada metin katmanı yok (taranmış ya da görsel olabilir; sayfa "
            f"{_page_list(textless)}): bu sayfaların içeriği notta eksik, gözden geçirin."
        )
    return None


def image_cap_warning(stats: dict) -> str | None:
    """Warning for pictures dropped by the keep-cap, with numbers that add up.
    The old images.stats_warning() (removed) printed stats["found"] as the document's picture
    count, but "found" also counts pictures filtered on purpose (tiny / template
    / unreadable): a real import said "538 görsel var; yalnız ilk 400 ... 86
    atlandı" and 400 + 86 = 486 (the other 52 were filtered noise). Here the
    count is kept + over_cap, the pictures the cap actually decided on, and the
    filtered ones are named separately."""
    over = int(stats.get("over_cap") or 0)
    if not over:
        return None
    kept = int(stats.get("kept") or 0)
    filtered = sum(int(stats.get(k) or 0) for k in ("tiny", "template", "unreadable"))
    msg = f"Belgede {kept + over} içerik görseli var; yalnız ilk {kept} tanesi eklendi, {over} görsel atlandı."
    if filtered:
        msg += f" ({filtered} küçük/tekrarlayan görsel zaten süzüldü.)"
    return msg


def _page_list(pages: list[int], limit: int = 10) -> str:
    shown = ", ".join(str(n) for n in pages[:limit])
    return shown + ", …" if len(pages) > limit else shown


# Temp dirs main() created (TeX-fixed PDF copies). The CLI removes them at exit;
# the serve worker removes them after every request (cleanup_work_dirs).
_WORK_DIRS: list[str] = []


def cleanup_work_dirs() -> None:
    while _WORK_DIRS:
        shutil.rmtree(_WORK_DIRS.pop(), ignore_errors=True)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="in_path", required=True)
    parser.add_argument("--out-dir", dest="out_dir", required=True)
    parser.add_argument(
        "--tool",
        default="auto",
        # pandoc was in the documented CLI contract (.claude/skills/source-ingest)
        # and in route_auto's .tex branch, but argparse rejected it — so a .tex
        # file could never be converted with an explicit --tool.
        choices=["auto", "markitdown", "marker", "docling", "pandoc"],
    )
    parser.add_argument("--dry-run", action="store_true")
    # See the module docstring's --source-name section (E5/K2-5).
    parser.add_argument("--source-name", dest="source_name", default=None)
    # #37, Aşama 7: only ever restricts the docling path — see route_auto's
    # and escalate_pdf's own doc comments for why.
    parser.add_argument("--pages", dest="pages", default=None)
    # Fallback PDF reader for docling — see the module docstring.
    parser.add_argument("--pdf-backend", dest="pdf_backend", default="default", choices=list(PDF_BACKENDS))
    # See the module docstring's Images section.
    parser.add_argument("--no-images", dest="images", action="store_false")
    # OCR language(s) for scanned pages, e.g. "tr,en" or "Türkçe, English" (names
    # or codes; see ocr_lang.py). Default: $VC_OCR_LANG, else the engine default.
    parser.add_argument("--ocr-lang", dest="ocr_lang", default=os.environ.get("VC_OCR_LANG") or None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    reset_run_state()
    _OCR_PLAN[0] = ocr_lang.resolve(args.ocr_lang)
    images.COLLECTOR.reset(enabled=args.images and not args.dry_run)

    in_path = Path(args.in_path)
    if not in_path.exists():
        emit({"type": "error", "message": f"Dosya bulunamadı: {in_path}"})
        return 1

    page_range: tuple[int, int] | None = None
    if args.pages:
        try:
            page_range = parse_page_range(args.pages)
        except ValueError as err:
            emit({"type": "error", "message": str(err)})
            return 1

    # A truncated PDF must be rejected before any converter sees it: docling
    # reports SUCCESS on it with pages missing. Applies to every --tool and to
    # --dry-run, and runs before the first progress event.
    pdf_pages = 0
    if in_path.suffix.lower() == PDF_EXT:
        try:
            pdf_pages = pdf_open_check(in_path)
        except PdfDamagedError as err:
            print(f"pdf_open_check: {err}", file=sys.stderr)
            emit({"type": "error", "code": "PDF_DAMAGED", "message": PDF_DAMAGED_MESSAGE})
            return 1

    # Old TeX PDFs: CM fonts whose /ToUnicode is missing or wrong make every
    # converter emit U+FFFD for primes, Delta, <=, integral signs and ≈ for ∞
    # (pdf_tounicode.py). When such a font exists, the converters and the text
    # layer readers below read a corrected COPY; the original stays the source
    # for hashing, title metadata and the damaged-PDF checks above. The copy
    # lives in the system temp dir, not the out-dir: a killed run must not
    # leave a stray PDF where the app looks for staged output. Any failure
    # inside prepare_pdf returns the original path.
    work_path = in_path
    tex_fix = {"fonts": 0, "codes": 0}
    if in_path.suffix.lower() == PDF_EXT:
        work_dir = tempfile.mkdtemp(prefix="vault-chat-tounicode-")
        if not _REUSE_CONVERTER[0]:
            atexit.register(shutil.rmtree, work_dir, ignore_errors=True)
        _WORK_DIRS.append(work_dir)
        work_path, tex_fix = pdf_tounicode.prepare_pdf(in_path, work_dir)
        work_path = Path(work_path)

    # Aşama 7: emitted before the (potentially many-minutes-long) conversion
    # call, not after — a caller sizing a timeout or showing an ETA needs
    # the page count before that call blocks, not once it's already done.
    if in_path.suffix.lower() == PDF_EXT:
        emit({"type": "progress", "stage": "converting", "pageCount": pdf_pages})
    else:
        emit({"type": "progress", "stage": "converting"})

    try:
        if args.tool == "auto":
            text, converted_by = route_auto(work_path, page_range=page_range, pdf_backend=args.pdf_backend)
        else:
            text, converted_by = route_explicit(work_path, args.tool, page_range=page_range, pdf_backend=args.pdf_backend)
    except PdfDamagedError as err:
        emit({"type": "error", "code": "PDF_DAMAGED", "message": f"{PDF_DAMAGED_MESSAGE} ({err})"})
        return 1
    except Exception as err:  # noqa: BLE001 — surfaced to the caller as a clean message either way
        emit({"type": "error", "message": str(err)})
        return 1

    emit({"type": "progress", "stage": "postprocessing"})
    is_pdf = in_path.suffix.lower() == PDF_EXT
    is_md = in_path.suffix.lower() == MD_EXT
    # docling drops spaces from PDF headings (98/194 on Trentelman); the PDF's
    # own text layer has them. MarkItDown emits no headings, so skip it there.
    if is_pdf and converted_by in ("docling", "marker"):
        lines, fragments = read_text_layer(work_path)
        text, _repaired = repair_headings(text, lines)
        # It also makes body-size labels (Theorem 2.19, Proof :) headings; demote those.
        text, _stats = restructure_headings(text, fragments)
    # A raw MarkItDown PDF pass that wasn't escalated can still be a bit
    # rough (page-break form-feeds, no headings at all) — flag for review
    # rather than silently presenting it as clean.
    needs_review = is_pdf and converted_by == "markitdown"

    existing_md_title: str | None = None
    if is_md:
        existing_frontmatter, text = split_existing_frontmatter(text)
        candidate = existing_frontmatter.get("title")
        existing_md_title = (
            candidate.strip() if isinstance(candidate, str) and not is_junk_title(candidate) else None
        )

    # K2-5: in_path.stem is never a usable title or filename — every caller
    # stages the real file under a generic name ("original.pdf") before
    # invoking this script, which is how five different real PDFs all came
    # back titled "original"/"input". --source-name carries the real one
    # through; callers that omit it get the old, worse fallback, not a crash.
    filename_fallback = Path(args.source_name).stem if args.source_name else in_path.stem
    # derive_title (postprocess.py) already prefers a real H1 over this
    # fallback — the PDF-specific tiers below only ever apply when the
    # converted body has none of its own; a re-uploaded .md's own frontmatter
    # title (if any) outranks the filename the same way.
    if is_pdf:
        title_fallback = derive_pdf_title(in_path) or filename_fallback
    elif is_md:
        title_fallback = existing_md_title or filename_fallback
    else:
        title_fallback = filename_fallback

    final_text, frontmatter = postprocess(
        text, title_fallback=title_fallback, converted_by=converted_by, needs_review=needs_review
    )

    # Until now this was always []: a conversion that destroyed every equation
    # in a textbook still reported zero warnings, so neither the import dialog
    # nor import-log.jsonl had anything to show.
    warnings = quality_warnings(final_text, is_pdf=is_pdf)
    # Ö6: neither the source's own frontmatter nor its body had a usable
    # title — flag it, since guessing from the filename is the last resort,
    # not something to present as if it were the note's real title.
    if is_md and existing_md_title is None and not re.search(r"^#\s+\S", text, re.MULTILINE):
        warnings.append("Başlık kaynak dosyada bulunamadı, dosya adından türetildi.")
    if is_pdf and _PRIMARY_FALLBACK:
        warnings.append(
            f"docling çalışmadı ({'; '.join(_PRIMARY_FALLBACK[:2])}); "
            f"{converted_by} ile dönüştürüldü — formüller ve tablolar bozuk olabilir, gözden geçirin."
        )
    textless = textless_pages_in_scope(work_path, page_range) if is_pdf else []
    textless_note = textless_warning(converted_by, textless, _OCR_RAN[0])
    if textless_note:
        warnings.append(textless_note)
    if converted_by == "docling" and _OCR_RAN[0]:
        if _OCR_PLAN[0] is not None:
            warnings.extend(_OCR_PLAN[0].warnings)
        if "```" in final_text:
            warnings.append(OCR_CODE_NOTE)
    if is_pdf and converted_by == "docling":
        glyph_note = glyph_check.check(text, work_path)
        if glyph_note:
            warnings.append(glyph_note)
    if is_pdf:
        warnings.extend(ocr_math_check.check(final_text, work_path))
    if converted_by == "docling" and _COLUMN_REPAIRED_PAGES:
        warnings.append(
            "Sütun sırası düzeltildi (docling okuma sırası): sayfa "
            + ", ".join(str(n) for n in _COLUMN_REPAIRED_PAGES)
        )
    if converted_by == "docling" and _READING_SUSPICIOUS_PAGES:
        warnings.append(
            f"Okuma sırası şüpheli: sayfa {_page_list(_READING_SUSPICIOUS_PAGES)} — kaynakla karşılaştırın."
        )
    if converted_by == "docling" and _HYBRID_BACKEND_USED[0]:
        warnings.append(HYBRID_BACKEND_WARNING)
    if converted_by == "docling" and _DOCLING_ERRORS:
        warnings.append("docling bazı sayfalarda hata bildirdi: " + "; ".join(_DOCLING_ERRORS[:3]))
    fatal_formulas = int((_FORMULA_FALLBACK_STATS[0] or {}).get("fatal_images", 0)) if converted_by == "docling" else 0
    if fatal_formulas:
        warnings.append(formula_fallback.fatal_warning(fatal_formulas, images_on=args.images))
    if warnings and not frontmatter.get("needs_review"):
        frontmatter["needs_review"] = True
    # Informational: a deterministic repair, appended AFTER the needs_review
    # decision so it does not flag an otherwise clean note for review.
    if tex_fix["fonts"]:
        warnings.append(f"{tex_fix['fonts']} yazı tipinin karakter eşlemesi onarıldı (eski TeX PDF'i)")
    if converted_by == "docling" and _READING_REPAIRED_PAGES:
        warnings.append(f"Okuma sırası düzeltildi (docling): sayfa {_page_list(_READING_REPAIRED_PAGES)}")

    # E5: the idempotency key and provenance record for the WHOLE pipeline
    # (knowledge-editor's schemas/frontmatter.yaml documents source_sha256
    # this way already) were never actually written — hashing the final
    # curated Markdown (confirm/+server.ts) answers "did the note change",
    # never "which original PDF/file did this come from" or "was this exact
    # file already imported once before".
    frontmatter["source_sha256"] = sha256_of_file(in_path)
    frontmatter["source_file"] = args.source_name or in_path.name

    if args.dry_run:
        emit({"type": "done", "outPath": None, "frontmatter": frontmatter, "warnings": warnings})
        return 0

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = unique_output_path(out_dir, in_path.stem)

    # After postprocess/quality_warnings on purpose: the final blocks hold
    # HTML comments and link syntax those passes were not written for.
    image_names: list[str] = []
    image_stats: dict | None = None
    if images.COLLECTOR.enabled and images.TOKEN_RE.search(final_text):
        final_text, image_stats, image_names = images.resolve_tokens(
            final_text, images.COLLECTOR.candidates, out_dir / "images", total_pages=images.COLLECTOR.total_pages
        )
        cap_note = image_cap_warning(image_stats)
        if cap_note:
            warnings.append(cap_note)
            frontmatter["needs_review"] = True
    elif images.TOKEN_RE.search(final_text):
        final_text = images.TOKEN_RE.sub("", final_text)
    # Okunamayan formüllerin yer tutucuları (formula_fallback.mark_fatal): kırpım PNG'si images/ altına
    # yazılır ve adı `images` listesine girer (Node tarafı onu _meta/attachments/'a taşır).
    if formula_fallback.FATAL_MARKER.search(final_text):
        final_text, formula_image_names = formula_fallback.resolve_markers(
            final_text, out_dir / "images" if images.COLLECTOR.enabled else None
        )
        image_names = image_names + [n for n in formula_image_names if n not in image_names]

    fm_lines = "\n".join(f"{k}: {json.dumps(v)}" for k, v in frontmatter.items())
    out_path.write_text(f"---\n{fm_lines}\n---\n\n{final_text}", encoding="utf-8")

    emit(
        {
            "type": "done",
            "outPath": str(out_path),
            "frontmatter": frontmatter,
            "warnings": warnings,
            "images": image_names,
            "imageStats": image_stats,
            "formulaEarlyStop": _FORMULA_STATS[0],
            "formulaCrop": _FORMULA_CROP_STATS[0],
            "formulaFallback": _FORMULA_FALLBACK_STATS[0],
        }
    )
    return 0


def serve() -> int:
    """--serve: a long-lived worker. One JSON request per stdin line,
    {"id": "...", "args": [<the CLI args>]}; each request runs main(args) with
    `id` stamped on every event, then {"type": "end", "id": ..., "exit": N}.
    A failing request never ends the worker; EOF on stdin does (exit 0). The
    point is _REUSE_CONVERTER: docling's models load once for the whole run."""
    for stream in (sys.stdin, sys.stdout):
        try:
            # Paths arrive as JSON text; the Windows ANSI default would mangle them.
            stream.reconfigure(encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass
    _REUSE_CONVERTER[0] = True
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            request_id = str(request["id"])
            argv = [str(a) for a in request["args"]]
        except Exception as err:  # noqa: BLE001 — no id to answer to
            print(f"serve: geçersiz istek yok sayıldı: {err}", file=sys.stderr, flush=True)
            continue
        _REQUEST_ID[0] = request_id
        code = 1
        try:
            code = main(argv)
        except SystemExit as err:  # argparse rejected the arguments
            emit({"type": "error", "message": "Geçersiz dönüştürücü argümanları"})
            code = err.code if isinstance(err.code, int) and err.code else 2
        except Exception as err:  # noqa: BLE001 — the worker must keep serving
            import traceback

            traceback.print_exc(file=sys.stderr)
            emit({"type": "error", "message": f"{type(err).__name__}: {err}"})
            code = 1
        finally:
            cleanup_work_dirs()
        emit({"type": "end", "exit": code})
        _REQUEST_ID[0] = None
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve"]:
        sys.exit(serve())
    sys.exit(main())
