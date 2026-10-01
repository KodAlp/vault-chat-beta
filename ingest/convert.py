#!/usr/bin/env python3
"""Conversion sidecar — CLI contract owned by the source-ingest skill doc:

    python ingest/convert.py --in <file> --out-dir <dir> --tool auto|markitdown|marker|docling|pandoc [--dry-run] [--source-name <name>]

JSON-lines progress on stdout, one object per line:
    {"type": "progress", "stage": "..."}
    {"type": "done", "outPath": "...", "warnings": [...]}
    {"type": "error", "message": "..."}

Marker and Docling are implemented but remain optional heavy extras (PyTorch,
multi-GB model weights) — they are commented out of requirements.txt. Requesting
one that is not installed, or auto-routing a PDF that needs it, reports a clear
"not installed" message instead of crashing or silently emitting garbage.
Detection is by ImportError at call time, not a hardcoded capability flag, so
installing them later needs no change here.

--source-name (2026-09-23, E5/K2-5): every caller (upload, batch upload, link
import) stages the input under a generic name (`original.pdf`) before calling
this script, to keep the staging dir collision-free — so --in's own stem is
never a usable title or source record. Pass the REAL filename here; it
becomes source_file frontmatter and the title fallback when the document has
no usable title of its own. Callers that omit it get the old (worse)
behavior — the staged name — never a crash.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable

from heading_repair import body_size, read_text_layer, repair_headings, restructure_headings
from postprocess import _apply_outside_verbatim, postprocess, quality_warnings

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


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


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
    return pdf_title_from_metadata(path) or pdf_title_from_first_large_line(path)


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


def convert_with_markitdown(path: Path) -> str:
    from markitdown import MarkItDown

    result = MarkItDown().convert(str(path))
    text = result.text_content
    if path.suffix.lower() == ".pptx":
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

    converter = PdfConverter(artifact_dict=create_model_dict())
    rendered = converter(str(path))
    text, _, _images = text_from_rendered(rendered)
    return text


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


def convert_with_docling(path: Path, page_range: tuple[int, int] | None = None) -> str:
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
      the installed CUDA. OCR now runs only when there is no text layer.

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
    — for a document too large to convert whole in one sitting.
    """
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import AcceleratorDevice, AcceleratorOptions, PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    options.do_ocr = not pdf_has_text_layer(path)
    options.do_formula_enrichment = True
    options.do_code_enrichment = True
    options.accelerator_options = AcceleratorOptions(device=AcceleratorDevice.AUTO)

    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
    )
    convert_kwargs = {"page_range": page_range} if page_range else {}
    result = converter.convert(str(path), **convert_kwargs)
    return result.document.export_to_markdown()


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


def route_auto(path: Path, page_range: tuple[int, int] | None = None) -> tuple[str, str]:
    """Returns (markdown_text, converted_by). page_range (#37) only ever
    restricts the docling escalation path below — MarkItDown's initial pass
    is fast enough on a huge document that there's nothing to save by
    partial-converting it too, and MarkItDown has no partial-page mode to
    give it anyway."""
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
        text = convert_with_markitdown(path)
        page_count = pdf_page_count(path) or text.count("\f") + 1
        if looks_broken(text, page_count):
            try:
                return escalate_pdf(path, page_range=page_range)
            except RuntimeError:
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
                raise
        return text, "markitdown"

    raise RuntimeError(f"Desteklenmeyen dosya türü: {ext}")


def escalate_pdf(path: Path, page_range: tuple[int, int] | None = None) -> tuple[str, str]:
    """Marker first, then Docling, then a clean error naming why each failed.

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
        ("docling", lambda: convert_with_docling(path, page_range=page_range)),
    ]
    for name, convert in attempts:
        try:
            return convert(), name
        except ImportError:
            reasons.append(f"{name}: kurulu değil")
        except Exception as err:  # noqa: BLE001 — reported, not swallowed
            reasons.append(f"{name}: {err}")

    raise RuntimeError(
        "Bu PDF karmaşık/taranmış görünüyor ve gelişmiş bir dönüştürücü "
        "gerektiriyor, ama hiçbiri çalışmadı — " + "; ".join(reasons)
    )


def route_explicit(path: Path, tool: str, page_range: tuple[int, int] | None = None) -> tuple[str, str]:
    try:
        if tool == "markitdown":
            return convert_with_markitdown(path), "markitdown"
        if tool == "marker":
            return convert_with_marker(path), "marker"
        if tool == "docling":
            return convert_with_docling(path, page_range=page_range), "docling"
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


def main() -> int:
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
    args = parser.parse_args()

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

    # Aşama 7: emitted before the (potentially many-minutes-long) conversion
    # call, not after — a caller sizing a timeout or showing an ETA needs
    # the page count before that call blocks, not once it's already done.
    if in_path.suffix.lower() == PDF_EXT:
        emit({"type": "progress", "stage": "converting", "pageCount": pdf_page_count(in_path)})
    else:
        emit({"type": "progress", "stage": "converting"})

    try:
        if args.tool == "auto":
            text, converted_by = route_auto(in_path, page_range=page_range)
        else:
            text, converted_by = route_explicit(in_path, args.tool, page_range=page_range)
    except Exception as err:  # noqa: BLE001 — surfaced to the caller as a clean message either way
        emit({"type": "error", "message": str(err)})
        return 1

    emit({"type": "progress", "stage": "postprocessing"})
    is_pdf = in_path.suffix.lower() == PDF_EXT
    is_md = in_path.suffix.lower() == MD_EXT
    # docling drops spaces from PDF headings (98/194 on Trentelman); the PDF's
    # own text layer has them. MarkItDown emits no headings, so skip it there.
    if is_pdf and converted_by in ("docling", "marker"):
        lines, fragments = read_text_layer(in_path)
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
        existing_md_title = candidate.strip() if isinstance(candidate, str) and candidate.strip() else None

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
    if warnings and not frontmatter.get("needs_review"):
        frontmatter["needs_review"] = True

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

    fm_lines = "\n".join(f"{k}: {json.dumps(v)}" for k, v in frontmatter.items())
    out_path.write_text(f"---\n{fm_lines}\n---\n\n{final_text}", encoding="utf-8")

    emit({"type": "done", "outPath": str(out_path), "frontmatter": frontmatter, "warnings": warnings})
    return 0


if __name__ == "__main__":
    sys.exit(main())
