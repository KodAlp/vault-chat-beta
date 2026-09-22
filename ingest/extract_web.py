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
import argparse
import json
import sys
from pathlib import Path

import trafilatura

from postprocess import postprocess

MIN_EXTRACTED_CHARS = 200


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


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

    try:
        text = trafilatura.extract(html, url=args.url, output_format="markdown")
    except Exception as err:  # noqa: BLE001 — trafilatura'nın iç hatası da temiz mesaja çevrilir
        emit({"type": "error", "message": f"İçerik ayıklanamadı: {err}"})
        return 1

    if not text or not text.strip():
        emit({"type": "error", "message": "Sayfadan okunabilir bir ana içerik ayıklanamadı (JS-ağırlıklı veya paywall'lı olabilir)."})
        return 1

    needs_review = len(text.strip()) < MIN_EXTRACTED_CHARS

    emit({"type": "progress", "stage": "postprocessing"})
    final_text, frontmatter = postprocess(
        text, title_fallback=args.url, converted_by="trafilatura", needs_review=needs_review
    )
    frontmatter["source_url"] = args.url

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "original.md"

    fm_lines = "\n".join(f"{k}: {json.dumps(v)}" for k, v in frontmatter.items())
    out_path.write_text(f"---\n{fm_lines}\n---\n\n{final_text}", encoding="utf-8")

    emit({"type": "done", "outPath": str(out_path), "frontmatter": frontmatter, "warnings": []})
    return 0


if __name__ == "__main__":
    sys.exit(main())
