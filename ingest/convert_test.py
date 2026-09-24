# -*- coding: utf-8 -*-
"""Tests for convert.py's pure helpers: title derivation, slide-heading
demotion, and the output-collision guard.

    python ingest/convert_test.py

Not part of `npm test` — same convention as postprocess_test.py/
heading_repair_test.py/youtube_transcript_test.py. Every check here exists
because of a real failure, mostly measured against real files (2026-09-23
report, Aşama 6):

- Five real PDFs came back titled "original"/"input" — the staged filename
  convert.py was invoked with, never the real one. title_from_fragments and
  --source-name (tested at the CLI-arg level, not here) are the fix.
- A real institutional-repository PDF (Trentelman) proved the naive "first
  text above body size" heuristic picks a repository cover page's
  institution/author block over the actual title on the next page, and that
  an unbounded search window lets a later chapter heading ("Preface")
  outscore the title too — see test_title_from_fragments below for both.
- A 29-slide .pptx came back with 29 top-level H1s (one per slide).
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from convert import (  # noqa: E402
    CODE_EXTENSIONS,
    convert_code_file,
    demote_slide_headings,
    looks_broken,
    parse_page_range,
    route_auto,
    split_existing_frontmatter,
    title_from_fragments,
    unique_output_path,
)

failures: list[str] = []


def check(name: str, ok: bool) -> None:
    print(("PASS  " if ok else "FAIL  ") + name)
    if not ok:
        failures.append(name)


def test_title_from_fragments() -> None:
    # The exact shape measured on Trentelman (see convert.py's doc comment):
    # a 12.0pt repository cover-page block, THEN the real 17.2pt title on
    # what read_text_layer(..., max_pages=N) would return as page 2, THEN
    # 12.0pt author/affiliation lines again.
    cover_then_title = [
        ("University of Groningen", 12.0),
        ("Control theory for linear systems", 12.0),
        ("Trentelman, Hendrikus", 12.0),
        ("some body text on the cover page", 8.0),
        ("more body text", 8.0),
        ("Control theory for linear systems", 17.2),  # the real title
        ("Harry L. Trentelman", 12.0),
        ("Research Institute of Mathematics", 12.0),
    ]
    check(
        "picks the single-largest-size run, not the first large-enough run",
        title_from_fragments(cover_then_title) == "Control theory for linear systems",
    )

    # A document with no cover page — the title genuinely is the first
    # large run, and there is only one size class above body.
    simple = [("A Simple Paper Title", 16.0), ("Author Name", 11.0), ("body text starts here", 10.0)]
    check("simple case: first (and only) large run wins", title_from_fragments(simple) == "A Simple Paper Title")

    check("empty input returns None, not an exception", title_from_fragments([]) is None)

    all_body_size = [("just prose", 10.0), ("more prose", 10.0)]
    check("nothing above the body-size threshold returns None", title_from_fragments(all_body_size) is None)

    # A multi-fragment title split across several runs at the same size must
    # be joined, not truncated to the first fragment. body_size() picks the
    # size with the most total character weight, so realistic proportions
    # matter here — enough 10.0pt filler that it, not the short title, is
    # correctly identified as the body size.
    split_title = [
        ("Cooley-Tukey", 14.0),
        ("FFT", 14.0),
        ("—", 14.0),
        ("Complexity", 14.0),
        ("author line one, at body size", 10.0),
        ("author line two, also at body size", 10.0),
        ("abstract text continues here at body size for a while", 10.0),
    ]
    check(
        "a title split across several fragments at the same size is joined",
        title_from_fragments(split_title) == "Cooley-Tukey FFT — Complexity",
    )


def test_demote_slide_headings() -> None:
    text = "# Slide One\n\ncontent\n\n# Slide Two\n\nmore content\n"
    out = demote_slide_headings(text)
    lines = out.split("\n")
    check("no line-start H1 survives", not any(line.startswith("# Slide") for line in lines))
    check("both slide titles demoted to H2", sum(line.startswith("## Slide") for line in lines) == 2)

    # A slide showing example code as plain text must not have its own
    # "# " comment mistaken for a slide title.
    with_fence = "# Real Title\n\n```python\n# not a heading, a comment\nprint(1)\n```\n"
    out2 = demote_slide_headings(with_fence)
    check("the real title is demoted", "## Real Title" in out2)
    check("a '# ' inside a fenced block is left alone", "# not a heading, a comment" in out2)
    check("the fenced comment was not itself demoted to ##", "## not a heading" not in out2)


def test_unique_output_path() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        check("fresh stem needs no suffix", unique_output_path(d, "fresh").name == "fresh.md")

        (d / "note.md").write_text("x", encoding="utf-8")
        check("K2: existing note.md is never silently overwritten", unique_output_path(d, "note").name == "note-2.md")

        (d / "note-2.md").write_text("x", encoding="utf-8")
        check("the next free suffix is found, not just -2 forever", unique_output_path(d, "note").name == "note-3.md")


def test_split_existing_frontmatter() -> None:
    # Ö6: a re-uploaded .md (a prior vault-chat export, an Obsidian note)
    # may already carry a frontmatter block — postprocess() must never see
    # it as body text, and its title (if any) should be readable back out.
    with_fm = '---\ntitle: "Var Olan Ba\\u015fl\\u0131k"\ntags: ["a", "b"]\n---\n\n# Body H1\n\nprose'
    meta, body = split_existing_frontmatter(with_fm)
    check("title read back out of an existing frontmatter block", meta.get("title") == "Var Olan Başlık")
    check("the frontmatter block itself is not part of the returned body", "---" not in body)
    check("body content survives", "# Body H1" in body and "prose" in body)

    no_fm = "# Just a heading\n\nprose, no frontmatter here at all"
    meta2, body2 = split_existing_frontmatter(no_fm)
    check("no frontmatter: empty meta, not an exception", meta2 == {})
    check("no frontmatter: body passed through byte-for-byte", body2 == no_fm)

    unterminated = "---\ntitle: x\nno closing fence anywhere"
    meta3, body3 = split_existing_frontmatter(unterminated)
    check("unterminated block: treated as no frontmatter, nothing silently dropped", meta3 == {} and body3 == unterminated)


def test_parse_page_range() -> None:
    # #37, Aşama 7: 1-indexed inclusive, matching docling's own convention
    # so the value passes straight through with no reindexing.
    check("simple range parses", parse_page_range("1-50") == (1, 50))
    check("single-page range parses", parse_page_range("12-12") == (12, 12))

    for bad in ["0-50", "50-1", "abc", "1-", "-50", "1-50-100", ""]:
        try:
            parse_page_range(bad)
            check(f"rejects invalid range {bad!r}", False)
        except ValueError:
            check(f"rejects invalid range {bad!r}", True)


def test_looks_broken_unaffected_by_this_pass() -> None:
    # Regression guard: convert.py was restructured around looks_broken()
    # (the S9 false-positive fallback wraps its caller, not looks_broken()
    # itself) — this must still flag the same things it always did.
    check("all-short-lines text still looks broken", looks_broken("a\nb\nc\nd\n", page_count=1))
    check(
        "a long PDF with zero headings still looks broken",
        looks_broken("normal prose line\n" * 300, page_count=10),
    )
    check(
        "normal prose with headings, short page count, does not look broken",
        not looks_broken("# Title\n\nSome real prose that is reasonably long.\n", page_count=1),
    )


def test_convert_code_file() -> None:
    # Kod dosyaları, Seçenek B (Aşama 11): the file becomes one fenced block,
    # nothing else — no heading, no title guess (main()'s title_fallback
    # already owns that, from --source-name).
    with tempfile.TemporaryDirectory() as d:
        py_path = Path(d) / "original.py"
        py_path.write_text("def f(x):\n    return x + 1\n", encoding="utf-8")
        out = convert_code_file(py_path)
        check("wraps in a python-tagged fence", out.startswith("```python\n"))
        check("body preserved verbatim", "def f(x):\n    return x + 1\n" in out)
        check("fence closed", out.rstrip().endswith("```"))

        # route_auto dispatches purely on extension, same as the .md
        # "already-markdown" branch — this is what /api/import's --tool auto
        # actually calls.
        text, converted_by = route_auto(py_path)
        check("route_auto recognizes a code extension", converted_by == "code-wrap")
        check("route_auto's output matches convert_code_file's", text == out)

    with tempfile.TemporaryDirectory() as d:
        # A stray ``` inside the source (e.g. a fenced snippet in a
        # docstring) must not be able to close the wrapper early — the fence
        # widens past the longest run already present.
        ts_path = Path(d) / "original.ts"
        ts_path.write_text("/** ```\n * example\n * ``` */\nexport const x = 1;\n", encoding="utf-8")
        out = convert_code_file(ts_path)
        check("fence widens past an embedded ``` run", out.startswith("````typescript\n"))
        check("embedded ``` survives untouched inside the wider fence", " * ```" in out)

    check(".html/.htm are not in CODE_EXTENSIONS (already routed as real documents)", ".html" not in CODE_EXTENSIONS and ".htm" not in CODE_EXTENSIONS)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    test_title_from_fragments()
    test_demote_slide_headings()
    test_unique_output_path()
    test_split_existing_frontmatter()
    test_parse_page_range()
    test_looks_broken_unaffected_by_this_pass()
    test_convert_code_file()
    print(f"\n{len(failures)} başarısız" if failures else "\nhepsi geçti")
    sys.exit(1 if failures else 0)
