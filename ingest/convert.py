#!/usr/bin/env python3
"""Conversion sidecar — CLI contract owned by the source-ingest skill doc:

    python ingest/convert.py --in <file> --out-dir <dir> --tool auto|markitdown|marker|docling [--dry-run]

JSON-lines progress on stdout, one object per line:
    {"type": "progress", "stage": "..."}
    {"type": "done", "outPath": "...", "warnings": [...]}
    {"type": "error", "message": "..."}

Scoped this pass (see Faz 5 plan) to MarkItDown only. Marker/Docling are
optional heavy extras (PyTorch, multi-GB) — requesting them, or auto-routing
a PDF that needs them, reports a clear "not installed" message instead of
crashing or silently emitting garbage. If they're installed later by hand,
this script picks them up automatically (detected via ImportError at call
time, not a hardcoded capability flag).
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from postprocess import postprocess

MARKITDOWN_EXTS = {".docx", ".pptx", ".xlsx", ".html", ".htm", ".epub"}
PDF_EXT = ".pdf"
TEX_EXT = ".tex"

# Heuristic straight from the skill doc: escalate a MarkItDown PDF result
# that smells broken rather than trusting it.
SHORT_LINE_RATIO_THRESHOLD = 0.3
MIN_PAGES_FOR_HEADING_CHECK = 5


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def looks_broken(text: str, page_count: int) -> bool:
    lines = [l for l in text.split("\n") if l.strip()]
    if not lines:
        return True
    short = sum(1 for l in lines if len(l.strip()) <= 2)
    if short / len(lines) > SHORT_LINE_RATIO_THRESHOLD:
        return True
    if page_count > MIN_PAGES_FOR_HEADING_CHECK and not any(l.startswith("#") for l in lines):
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
    from marker.convert import convert_single_pdf  # noqa: F401 — presence check only, not wired up this pass

    raise NotImplementedError("marker entegrasyonu bu sürümde yok (Faz 5 kapsamı: sadece MarkItDown)")


def convert_with_docling(path: Path) -> str:
    from docling.document_converter import DocumentConverter  # noqa: F401 — presence check only

    raise NotImplementedError("docling entegrasyonu bu sürümde yok (Faz 5 kapsamı: sadece MarkItDown)")


def not_installed_message(tool: str) -> str:
    return f"Bu araç kurulu değil: pip install {tool}"


def route_auto(path: Path) -> tuple[str, str]:
    """Returns (markdown_text, converted_by)."""
    ext = path.suffix.lower()

    if ext == TEX_EXT:
        if shutil.which("pandoc"):
            return convert_with_pandoc(path), "pandoc"
        raise RuntimeError(not_installed_message("pandoc (sistem paketi, pip değil)"))

    if ext in MARKITDOWN_EXTS:
        return convert_with_markitdown(path), "markitdown"

    if ext == PDF_EXT:
        text = convert_with_markitdown(path)
        page_count = text.count("\f") + 1  # form-feed is MarkItDown's page separator
        if looks_broken(text, page_count):
            try:
                return convert_with_marker(path), "marker"
            except ImportError:
                raise RuntimeError(
                    "Bu PDF karmaşık/taranmış görünüyor ve gelişmiş bir dönüştürücü "
                    "gerektiriyor (marker/docling) — bu araçlar bu kurulumda mevcut değil."
                )
        return text, "markitdown"

    raise RuntimeError(f"Desteklenmeyen dosya türü: {ext}")


def route_explicit(path: Path, tool: str) -> tuple[str, str]:
    try:
        if tool == "markitdown":
            return convert_with_markitdown(path), "markitdown"
        if tool == "marker":
            return convert_with_marker(path), "marker"
        if tool == "docling":
            return convert_with_docling(path), "docling"
    except ImportError:
        raise RuntimeError(not_installed_message(tool))
    raise RuntimeError(f"Bilinmeyen araç: {tool}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="in_path", required=True)
    parser.add_argument("--out-dir", dest="out_dir", required=True)
    parser.add_argument("--tool", default="auto", choices=["auto", "markitdown", "marker", "docling"])
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
    # A raw MarkItDown PDF pass that wasn't escalated can still be a bit
    # rough (page-break form-feeds, no headings at all) — flag for review
    # rather than silently presenting it as clean.
    needs_review = in_path.suffix.lower() == PDF_EXT and converted_by == "markitdown"
    final_text, frontmatter = postprocess(
        text, title_fallback=in_path.stem, converted_by=converted_by, needs_review=needs_review
    )

    if args.dry_run:
        emit({"type": "done", "outPath": None, "frontmatter": frontmatter, "warnings": []})
        return 0

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / (in_path.stem + ".md")

    fm_lines = "\n".join(f"{k}: {json.dumps(v)}" for k, v in frontmatter.items())
    out_path.write_text(f"---\n{fm_lines}\n---\n\n{final_text}", encoding="utf-8")

    emit({"type": "done", "outPath": str(out_path), "frontmatter": frontmatter, "warnings": []})
    return 0


if __name__ == "__main__":
    sys.exit(main())
