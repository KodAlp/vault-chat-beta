# -*- coding: utf-8 -*-
"""Tests for extract_web.py's pure helpers: trafilatura metadata-block
parsing and the URL-based title fallback.

    python ingest/extract_web_test.py

Not part of `npm test` — same convention as postprocess_test.py/
convert_test.py. Every check here exists because of a real failure
(2026-09-23 report, Aşama 6, K2-5's HTML case):

- extract_web.py called trafilatura.extract() without with_metadata=True,
  so pages with no H1 fell back to title_fallback=args.url — the raw URL
  string, query params and all, ended up as the note's title.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_web import parse_trafilatura_metadata, title_from_url  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool) -> None:
    print(("PASS  " if ok else "FAIL  ") + name)
    if not ok:
        failures.append(name)


def test_parse_trafilatura_metadata() -> None:
    block = "---\ntitle: Scanning\nurl: https://example.com/x\nhostname: example.com\n---\n# Scanning\n\nbody text"
    meta, body = parse_trafilatura_metadata(block)
    check("title extracted from the metadata block", meta.get("title") == "Scanning")
    check("hostname extracted too", meta.get("hostname") == "example.com")
    check("body has the metadata block stripped off", body == "# Scanning\n\nbody text")

    no_block = "# Scanning\n\nbody text, no metadata prefix at all"
    meta2, body2 = parse_trafilatura_metadata(no_block)
    check("no metadata block: empty meta dict, not an exception", meta2 == {})
    check("no metadata block: body passed through unchanged", body2 == no_block)

    check("empty input doesn't crash", parse_trafilatura_metadata("") == ({}, ""))

    unterminated = "---\ntitle: x\nno closing fence"
    meta3, body3 = parse_trafilatura_metadata(unterminated)
    check("unterminated block: treated as no metadata, not truncated", meta3 == {} and body3 == unterminated)


def test_title_from_url() -> None:
    check(
        "last path segment, percent-decoded",
        title_from_url("https://example.com/notes/some%20page.html") == "some page.html",
    )
    check(
        "trailing slash is ignored, segment before it is used",
        title_from_url("https://example.com/book/scanning/") == "scanning",
    )
    check(
        "no path at all falls back to the hostname, not the empty string",
        title_from_url("https://example.com") == "example.com",
    )
    check(
        "malformed percent-encoding doesn't raise, just passes through",
        title_from_url("https://example.com/a%zzpage") == "a%zzpage",
    )


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    test_parse_trafilatura_metadata()
    test_title_from_url()
    print(f"\n{len(failures)} başarısız" if failures else "\nhepsi geçti")
    sys.exit(1 if failures else 0)
