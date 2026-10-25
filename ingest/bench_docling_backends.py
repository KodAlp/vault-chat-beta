#!/usr/bin/env python3
"""Compare docling's default PDF backend with the hybrid fallback on one PDF.

    python ingest/bench_docling_backends.py <pdf> [--backend default|hybrid|both]
        [--groundtruth words.json --key <name>] [--pages START-END]

Same pipeline options as convert.py's convert_with_docling (formula + code
enrichment on, OCR only without a text layer, AUTO device), so the numbers
match what an import would do. Prints one JSON line per backend: status,
pages, word recall against a ground-truth word list (if given), Markdown
length, `$$` count and seconds.

Not part of any test run — this is the re-measurement tool for
the docling PDF backends (first measured 2026-10-07). Re-run it on the same files
whenever docling / docling-parse is upgraded (hybrid_backend.py depends on
docling internals). Needs the optional extras (requirements-optional.txt).

Ground truth: a JSON object mapping a key to a list of words, e.g. the
words of the PDF's own text layer for the pages being compared.
"""
from __future__ import annotations

import argparse
import collections
import json
import logging
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from convert import parse_page_range, pdf_has_text_layer  # noqa: E402


def _norm(words: list[str]) -> collections.Counter:
    return collections.Counter(w for w in (re.sub(r"[^\w]", "", x.lower()) for x in words) if w)


def run(pdf: Path, backend: str, page_range, truth: list[str] | None) -> dict:
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import AcceleratorDevice, AcceleratorOptions, PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    options.do_ocr = not pdf_has_text_layer(pdf)
    options.do_formula_enrichment = True
    options.do_code_enrichment = True
    options.accelerator_options = AcceleratorOptions(device=AcceleratorDevice.AUTO)
    if backend == "hybrid":
        from hybrid_backend import HybridDoclingParseBackend

        fmt = PdfFormatOption(pipeline_options=options, backend=HybridDoclingParseBackend)
    else:
        fmt = PdfFormatOption(pipeline_options=options)

    kwargs = {"page_range": page_range} if page_range else {}
    started = time.time()
    result = DocumentConverter(format_options={InputFormat.PDF: fmt}).convert(str(pdf), **kwargs)
    md = result.document.export_to_markdown()
    seconds = time.time() - started

    recall = None
    if truth is not None:
        want, got = _norm(truth), _norm(md.split())
        recall = round(sum(min(c, got[w]) for w, c in want.items()) / max(1, sum(want.values())), 3)
    return {
        "file": pdf.name,
        "backend": backend,
        "ocr": options.do_ocr,
        "status": str(result.status),
        "pages": len(result.pages),
        "recall": recall,
        "chars": len(md),
        "formulas": md.count("$$"),
        "seconds": round(seconds, 1),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf")
    parser.add_argument("--backend", choices=["default", "hybrid", "both"], default="both")
    parser.add_argument("--groundtruth")
    parser.add_argument("--key")
    parser.add_argument("--pages")
    args = parser.parse_args()

    logging.disable(logging.WARNING)
    truth = None
    if args.groundtruth:
        data = json.loads(Path(args.groundtruth).read_text(encoding="utf-8"))
        truth = data[args.key or Path(args.pdf).stem]
    page_range = parse_page_range(args.pages) if args.pages else None
    backends = ["default", "hybrid"] if args.backend == "both" else [args.backend]
    for backend in backends:
        print(json.dumps(run(Path(args.pdf), backend, page_range, truth), ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
