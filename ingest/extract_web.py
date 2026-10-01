#!/usr/bin/env python3
"""Web page extraction sidecar — CLI contract mirrors convert.py:

    python ingest/extract_web.py --in <html-dosyası> --url <orijinal-url> --out-dir <dir>

JSON-lines progress on stdout, one object per line:
    {"type": "progress", "stage": "..."}
    {"type": "done", "outPath": "...", "frontmatter": {...}, "warnings": [...]}
    {"type": "error", "message": "..."}

Reads already-downloaded HTML from disk (--in) rather than fetching --url
itself — the Node caller already did the one fetch; re-fetching here would
double the network cost and reintroduce the SSRF/size checks Node already
applied. --url is passed through only so trafilatura can resolve relative
links/canonical metadata during extraction.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

import trafilatura

from mathml_convert import replace_math_with_placeholders
from postprocess import postprocess

MIN_EXTRACTED_CHARS = 200


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def parse_trafilatura_metadata(output: str) -> tuple[dict[str, str], str]:
    """trafilatura's `with_metadata=True` prepends a `---\\nkey: value\\n...\\n---\\n`
    block ahead of the body. Not real YAML parsing — pyyaml is not a required
    dependency here (it's only pulled in transitively by the optional
    docling/marker extras in requirements-optional.txt; web import is core,
    not optional, and must not gain a hard dependency on something that
    might not be installed), and this fixed, trafilatura-controlled shape
    needs nothing more than line-based `key: value` splitting."""
    if not output.startswith("---\n"):
        return {}, output
    end = output.find("\n---\n", 4)
    if end == -1:
        return {}, output
    header = output[4:end]
    body = output[end + 5 :]
    meta: dict[str, str] = {}
    for line in header.split("\n"):
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip()
    return meta, body


def title_from_url(url: str) -> str:
    """K2-5's URL-side fallback — mirrors link-import.ts's sourceNameFromUrl:
    the last path segment is usually more descriptive than the bare
    technical string a raw URL is, which is what title_fallback=args.url
    used to hand straight to postprocess.py's derive_title()."""
    path = urlparse(url).path
    last_segment = [p for p in path.split("/") if p][-1:] or []
    if not last_segment:
        return urlparse(url).hostname or url
    try:
        return unquote(last_segment[0])
    except (ValueError, UnicodeDecodeError):
        return last_segment[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="in_path", required=True)
    parser.add_argument("--url", dest="url", required=True)
    parser.add_argument("--out-dir", dest="out_dir", required=True)
    args = parser.parse_args()

    in_path = Path(args.in_path)
    if not in_path.exists():
        emit({"type": "error", "message": f"Dosya bulunamadı: {in_path}"})
        return 1

    emit({"type": "progress", "stage": "extracting"})
    html = in_path.read_text(encoding="utf-8", errors="replace")

    # Aşama 10 #2: trafilatura silently drops <math> elements (measured —
    # see mathml_convert.py's docstring), so every formula is turned into a
    # $...$/$$...$$ text placeholder BEFORE trafilatura ever sees the HTML.
    math_failed = 0
    try:
        html, _math_total, math_failed = replace_math_with_placeholders(html)
    except Exception:  # noqa: BLE001 — a malformed page must not block the whole import over math handling
        pass

    try:
        raw = trafilatura.extract(html, url=args.url, output_format="markdown", with_metadata=True)
    except Exception as err:  # noqa: BLE001 — trafilatura'nın iç hatası da temiz mesaja çevrilir
        emit({"type": "error", "message": f"İçerik ayıklanamadı: {err}"})
        return 1

    if not raw or not raw.strip():
        emit({"type": "error", "message": "Sayfadan okunabilir bir ana içerik ayıklanamadı (JS-ağırlıklı veya paywall'lı olabilir)."})
        return 1

    meta, text = parse_trafilatura_metadata(raw)
    needs_review = len(text.strip()) < MIN_EXTRACTED_CHARS or math_failed > 0

    # K2-5: sayfa <title>/og:title varsa ondan, yoksa URL'nin son path
    # segmentinden (link-import.ts'in sourceNameFromUrl'üyle aynı fikir) —
    # ham URL'nin tamamı title_fallback olarak kullanılmıyor artık, çünkü
    # postprocess.py'nin derive_title'ı H1 bulamazsa bunu olduğu gibi
    # başlığa yazıyordu.
    title_fallback = meta.get("title") or title_from_url(args.url)

    emit({"type": "progress", "stage": "postprocessing"})
    final_text, frontmatter = postprocess(
        text, title_fallback=title_fallback, converted_by="trafilatura", needs_review=needs_review
    )
    frontmatter["source_url"] = args.url

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "original.md"

    fm_lines = "\n".join(f"{k}: {json.dumps(v)}" for k, v in frontmatter.items())
    out_path.write_text(f"---\n{fm_lines}\n---\n\n{final_text}", encoding="utf-8")

    warnings = [f"{math_failed} matematik ifadesi MathML'den LaTeX'e çevrilemedi, olduğu gibi işaretlendi"] if math_failed > 0 else []
    emit({"type": "done", "outPath": str(out_path), "frontmatter": frontmatter, "warnings": warnings})
    return 0


if __name__ == "__main__":
    sys.exit(main())
