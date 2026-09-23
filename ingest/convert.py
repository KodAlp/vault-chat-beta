#!/usr/bin/env python3
"""Conversion sidecar — CLI contract owned by the source-ingest skill doc:

    python ingest/convert.py --in <file> --out-dir <dir> --tool auto|markitdown|marker|docling|pandoc [--dry-run]

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
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

from heading_repair import read_text_layer, repair_headings, restructure_headings
from postprocess import postprocess, quality_warnings

MARKITDOWN_EXTS = {".docx", ".pptx", ".xlsx", ".html", ".htm", ".epub"}
PDF_EXT = ".pdf"
TEX_EXT = ".tex"

# Heuristic straight from the skill doc: escalate a MarkItDown PDF result
# that smells broken rather than trusting it.
SHORT_LINE_RATIO_THRESHOLD = 0.3
MIN_PAGES_FOR_HEADING_CHECK = 5
CID_ARTIFACT = re.compile(r"\(cid:\d+\)")
# A handful can appear in any PDF; hundreds mean the font mapping is gone.
CID_ARTIFACT_THRESHOLD = 50


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


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


def convert_with_markitdown(path: Path) -> str:
    from markitdown import MarkItDown

    result = MarkItDown().convert(str(path))
    return result.text_content


def convert_with_pandoc(path: Path) -> str:
    proc = subprocess.run(
        ["pandoc", "-f", "latex", "-t", "gfm", str(path)],
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


def convert_with_docling(path: Path) -> str:
    """docling 2.x — preferred over marker when the document's value is in its
    tables, and the only one of the two that works on Windows (see
    escalate_pdf). Same optional-extra and ImportError contract as marker.

    The defaults are wrong for this app and all three overrides were measured
    on Trentelman's 404-page control theory book:

    - `do_formula_enrichment` is off by default, and without it docling detects
      every display equation and decodes none: the first run produced 1239
      `<!-- formula-not-decoded -->` placeholders and zero LaTeX. Good prose
      with holes where the mathematics was is worse than a failed conversion,
      because it looks complete.
    - `do_code_enrichment` is off by default, which matters for the CS and ML
      sources in this library.
    - `do_ocr` is on by default. That book is born-digital, so all 404 pages
      were OCR'd for nothing — on CPU, because onnxruntime-gpu did not match
      the installed CUDA. OCR now runs only when there is no text layer.
    """
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    options.do_ocr = not pdf_has_text_layer(path)
    options.do_formula_enrichment = True
    options.do_code_enrichment = True

    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
    )
    result = converter.convert(str(path))
    return result.document.export_to_markdown()


def not_installed_message(tool: str) -> str:
    return f"Bu araç kurulu değil: pip install {tool}"


def pandoc_not_installed_message() -> str:
    return "Bu araç kurulu değil: pandoc bir sistem paketi, pip install ile kurulmaz — https://pandoc.org/installing.html"


def route_auto(path: Path) -> tuple[str, str]:
    """Returns (markdown_text, converted_by)."""
    ext = path.suffix.lower()

    if ext == TEX_EXT:
        if shutil.which("pandoc"):
            return convert_with_pandoc(path), "pandoc"
        raise RuntimeError(pandoc_not_installed_message())

    if ext in MARKITDOWN_EXTS:
        return convert_with_markitdown(path), "markitdown"

    if ext == PDF_EXT:
        text = convert_with_markitdown(path)
        page_count = pdf_page_count(path) or text.count("\f") + 1
        if looks_broken(text, page_count):
            return escalate_pdf(path)
        return text, "markitdown"

    raise RuntimeError(f"Desteklenmeyen dosya türü: {ext}")


def escalate_pdf(path: Path) -> tuple[str, str]:
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
    broken rather than silently degrading.
    """
    reasons: list[str] = []
    for convert, name in ((convert_with_marker, "marker"), (convert_with_docling, "docling")):
        try:
            return convert(path), name
        except ImportError:
            reasons.append(f"{name}: kurulu değil")
        except Exception as err:  # noqa: BLE001 — reported, not swallowed
            reasons.append(f"{name}: {err}")

    raise RuntimeError(
        "Bu PDF karmaşık/taranmış görünüyor ve gelişmiş bir dönüştürücü "
        "gerektiriyor, ama hiçbiri çalışmadı — " + "; ".join(reasons)
    )


def route_explicit(path: Path, tool: str) -> tuple[str, str]:
    try:
        if tool == "markitdown":
            return convert_with_markitdown(path), "markitdown"
        if tool == "marker":
            return convert_with_marker(path), "marker"
        if tool == "docling":
            return convert_with_docling(path), "docling"
        if tool == "pandoc":
            if not shutil.which("pandoc"):
                raise RuntimeError(pandoc_not_installed_message())
            return convert_with_pandoc(path), "pandoc"
    except ImportError:
        raise RuntimeError(not_installed_message(tool))
    raise RuntimeError(f"Bilinmeyen araç: {tool}")


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
    args = parser.parse_args()

    in_path = Path(args.in_path)
    if not in_path.exists():
        emit({"type": "error", "message": f"Dosya bulunamadı: {in_path}"})
        return 1

    emit({"type": "progress", "stage": "converting"})
    try:
        if args.tool == "auto":
            text, converted_by = route_auto(in_path)
        else:
            text, converted_by = route_explicit(in_path, args.tool)
    except Exception as err:  # noqa: BLE001 — surfaced to the caller as a clean message either way
        emit({"type": "error", "message": str(err)})
        return 1

    emit({"type": "progress", "stage": "postprocessing"})
    is_pdf = in_path.suffix.lower() == PDF_EXT
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
    final_text, frontmatter = postprocess(
        text, title_fallback=in_path.stem, converted_by=converted_by, needs_review=needs_review
    )

    # Until now this was always []: a conversion that destroyed every equation
    # in a textbook still reported zero warnings, so neither the import dialog
    # nor import-log.jsonl had anything to show.
    warnings = quality_warnings(final_text, is_pdf=is_pdf)
    if warnings and not frontmatter.get("needs_review"):
        frontmatter["needs_review"] = True

    if args.dry_run:
        emit({"type": "done", "outPath": None, "frontmatter": frontmatter, "warnings": warnings})
        return 0

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / (in_path.stem + ".md")

    fm_lines = "\n".join(f"{k}: {json.dumps(v)}" for k, v in frontmatter.items())
    out_path.write_text(f"---\n{fm_lines}\n---\n\n{final_text}", encoding="utf-8")

    emit({"type": "done", "outPath": str(out_path), "frontmatter": frontmatter, "warnings": warnings})
    return 0


if __name__ == "__main__":
    sys.exit(main())
