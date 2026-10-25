# -*- coding: utf-8 -*-
"""Tests for convert.py's pure helpers: title derivation, slide-heading
demotion, and the output-collision guard.

    python ingest/convert_test.py

Not part of `npm test` — same convention as postprocess_test.py/
heading_repair_test.py/youtube_transcript_test.py. Every check here exists
because of a real failure, mostly measured against real files (2026-09-23
report):

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
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import convert  # noqa: E402
from convert import (  # noqa: E402
    CODE_EXTENSIONS,
    PdfDamagedError,
    image_cap_warning,
    classify_page_shortfall,
    docling_page_numbers,
    scope_page_numbers,
    derive_pdf_title,
    textless_pages,
    convert_code_file,
    demote_slide_headings,
    escalate_pdf,
    _is_open_failure,
    expected_page_count,
    looks_broken,
    parse_page_range,
    pdf_open_check,
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


def _deck(slides: list[str]) -> str:
    return "\n\n".join(f"<!-- Slide number: {i} -->\n{body}" for i, body in enumerate(slides, 1))


def test_clean_pptx_noise() -> None:
    footer = "Dr. Öğr. Üyesi Ad Soyad – Üniversite Bölümü"

    # Empty notes: heading removed, nothing else lost.
    deck = _deck([f"# A\n\nbir\n\n{footer}\n1\n\n### Notes:\n", f"# B\n\niki\n\n{footer}\n2\n\n### Notes:\n",
                  f"# C\n\nüç\n\n{footer}\n3", f"# D\n\ndört\n\n{footer}\n4"])
    out, st = convert.clean_pptx_noise(deck)
    check("empty Notes headings removed", "Notes" not in out and st["notes_removed"] == 2)
    check("slide-number comments kept", all(f"<!-- Slide number: {i} -->" in out for i in range(1, 5)))
    check("bare slide numbers dropped", st["slide_numbers"] == 4 and "\n1\n" not in out and "\n4" not in out.split("dört")[1])
    check("footer kept once (first occurrence)", out.count(footer) == 1 and st["footers"] == 3)
    check("content untouched", all(w in out for w in ("bir", "iki", "üç", "dört")))

    # Non-empty notes: relabeled, never a heading.
    out2, st2 = convert.clean_pptx_noise(_deck(["# A\n\nx\n\n### Notes:\nKonuş şunu söyle", "# B\n\ny"]))
    check("non-empty notes relabeled", "**Konuşmacı notu:**\nKonuş şunu söyle" in out2 and st2["notes_relabeled"] == 1)
    check("no Notes heading remains", "Notes:" not in out2)

    # A slide number only goes from its own slide: "2" on slide 1 is content.
    out3, _ = convert.clean_pptx_noise(_deck(["# A\n\n2\n\ntext\n\n1", "# B\n\n2", "# C", "# D"]))
    s1, s2 = out3.split("<!-- Slide number: 2 -->")
    check("number of another slide is kept", "\n2\n" in s1 and "\n1" not in s1.split("# A")[1])
    check("own number dropped on slide 2", "2" not in s2.replace("# B", ""))

    # A line-number gutter that happens to contain the slide's own number.
    gutter = "\n".join(str(n) for n in range(1, 6))
    out8, st8 = convert.clean_pptx_noise(_deck(["# A", "# B", f"# C\n\n{gutter}\ncode"]))
    check("gutter number inside a listing kept", "\n3\n" in out8 and st8["slide_numbers"] == 0)

    # Fewer than 4 slides: footer untouched.
    out4, st4 = convert.clean_pptx_noise(_deck([f"# A\n\n{footer}", f"# B\n\n{footer}", f"# C\n\n{footer}"]))
    check("<4 slides: footer untouched", out4.count(footer) == 3 and st4["footers"] == 0)

    # A line on only 50% of slides is content, not a footer.
    half = _deck([f"# S{i}\n\n{'ortak satır' if i <= 4 else 'başka'}" for i in range(1, 9)])
    out5, st5 = convert.clean_pptx_noise(half)
    check("line on 50% of slides kept", out5.count("ortak satır") == 4 and st5["footers"] == 0)

    # Headings, tables, image lines and markers are never footer candidates.
    rep = "\n".join(["![x](a.png)", "<!-- vc:img 0 -->", "| a | b |", "## Alt başlık"])
    out6, st6 = convert.clean_pptx_noise(_deck([f"# T{i}\n\n{rep}" for i in range(1, 6)]))
    check("headings/tables/images/markers kept", out6.count("<!-- vc:img 0 -->") == 5 and out6.count("| a | b |") == 5
          and out6.count("![x](a.png)") == 5 and out6.count("## Alt başlık") == 5 and st6["footers"] == 0)

    # Fenced code with a Notes-looking line or repeated lines is left alone.
    code = "```\n### Notes:\nprint(1)\n```"
    out7, _ = convert.clean_pptx_noise(_deck([f"# T{i}\n\n{code}" for i in range(1, 6)]))
    check("fenced code untouched", out7.count("### Notes:") == 5 and out7.count("print(1)") == 5)

    # No slide markers: not a MarkItDown deck, returned verbatim.
    plain = "# X\n\n### Notes:\n"
    check("no markers -> unchanged", convert.clean_pptx_noise(plain)[0] == plain)

    # Title: with the bogus heading gone the first real slide title wins.
    from postprocess import postprocess
    raw = _deck(["Kapak yazısı\n\n### Notes:\n", "# İkinci\n\nx\n\n### Notes:\n"])
    cleaned, _ = convert.clean_pptx_noise(raw)
    _, fm = postprocess(demote_slide_headings(cleaned), title_fallback="dosya", converted_by="markitdown", needs_review=False)
    check("title is never 'Notes:'", fm["title"] != "Notes:")
    _, fm_old = postprocess(demote_slide_headings(raw), title_fallback="dosya", converted_by="markitdown", needs_review=False)
    check("(old behaviour reproduced: Notes: title)", fm_old["title"] == "Notes:")


def test_unique_output_path() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        check("fresh stem needs no suffix", unique_output_path(d, "fresh").name == "fresh.md")

        (d / "note.md").write_text("x", encoding="utf-8")
        check("existing note.md is never silently overwritten", unique_output_path(d, "note").name == "note-2.md")

        (d / "note-2.md").write_text("x", encoding="utf-8")
        check("the next free suffix is found, not just -2 forever", unique_output_path(d, "note").name == "note-3.md")


def test_split_existing_frontmatter() -> None:
    # A re-uploaded .md (a prior vault-chat export, an Obsidian note)
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
    # 1-indexed inclusive, matching docling's own convention
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
    # (the false-positive fallback wraps its caller, not looks_broken()
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
    # Kod dosyaları: the file becomes one fenced block,
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


def make_pdf(path: Path, pages: int = 4) -> None:
    from pypdf import PdfWriter

    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=200, height=200)
    with path.open("wb") as f:
        w.write(f)


def test_pdf_damage_checks() -> None:
    with tempfile.TemporaryDirectory() as d:
        good = Path(d) / "good.pdf"
        make_pdf(good, 4)
        check("pdf_open_check returns the page count of a valid PDF", pdf_open_check(good) == 4)

        # Cut at 60%: the xref table/trailer live at the end of the file, so
        # pypdf cannot open it — the same failure mode as a half-downloaded file.
        cut = Path(d) / "cut.pdf"
        data = good.read_bytes()
        cut.write_bytes(data[: int(len(data) * 0.6)])
        try:
            pdf_open_check(cut)
            raised = False
        except PdfDamagedError:
            raised = True
        check("pdf_open_check raises PdfDamagedError on a truncated PDF", raised)

        garbage = Path(d) / "garbage.pdf"
        garbage.write_bytes(b"not a pdf at all")
        try:
            pdf_open_check(garbage)
            raised = False
        except PdfDamagedError:
            raised = True
        check("pdf_open_check raises PdfDamagedError on a non-PDF", raised)

        # CLI contract: JSON error with code on stdout, exit 1, no stray lines.
        proc = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parent / "convert.py"), "--in", str(cut),
             "--out-dir", str(Path(d) / "out"), "--tool", "auto", "--dry-run"],
            capture_output=True, text=True, encoding="utf-8",
        )
        lines = [l for l in proc.stdout.splitlines() if l.strip()]
        parsed: list[dict] = []
        all_json = True
        for l in lines:
            try:
                parsed.append(json.loads(l))
            except ValueError:
                all_json = False
        check("CLI: truncated PDF exits 1", proc.returncode == 1)
        check("CLI: stdout holds only JSON lines", all_json and bool(lines))
        last = parsed[-1] if parsed else {}
        check("CLI: last line is type=error code=PDF_DAMAGED", last.get("type") == "error" and last.get("code") == "PDF_DAMAGED")
        check("CLI: no progress event before the error", all(p.get("type") != "progress" for p in parsed))


def test_scanned_pdf_not_damaged() -> None:
    """An image-only scan opens in pypdf; a docling page shortfall on image-only
    pages is a conversion failure, not PDF_DAMAGED."""
    from PIL import Image, ImageDraw

    with tempfile.TemporaryDirectory() as d:
        scan = Path(d) / "scan.pdf"
        imgs = []
        for i in range(4):
            im = Image.new("RGB", (400, 500), "white")
            ImageDraw.Draw(im).text((20, 20), f"scan {i}", fill="black")
            imgs.append(im)
        imgs[0].save(scan, save_all=True, append_images=imgs[1:], resolution=100)
        check("scanned PDF passes pdf_open_check", pdf_open_check(scan) == 4)
        check("scanned PDF: every page is image-only", textless_pages(scan) == [1, 2, 3, 4])
        image_only = set(textless_pages(scan))
        expected = scope_page_numbers(4, None)
        check("shortfall on scan pages is not damage", classify_page_shortfall(expected, {1, 2}, image_only) == ("scan", [3, 4]))
        check("zero pages on a scan is not damage", classify_page_shortfall(expected, set(), image_only) == ("scan", [1, 2, 3, 4]))
        check("missing text page stays damaged", classify_page_shortfall(expected, {1, 2}, {3}) == ("damaged", [3, 4]))
        check("unknown page numbers stay damaged", classify_page_shortfall(expected, None, image_only)[0] == "damaged")
        check("scope_page_numbers honours page_range", scope_page_numbers(10, (3, 5)) == {3, 4, 5})

    class _P:
        def __init__(self, n): self.page_no = n

    class _R:
        def __init__(self, ns): self.pages = [_P(n) for n in ns]

    check("docling_page_numbers collects page_no", docling_page_numbers([_R([1, 2]), _R([5])]) == {1, 2, 5})

    class _NoNo:
        pages = [object()]

    check("docling_page_numbers None without page_no", docling_page_numbers([_NoNo()]) is None)


def test_pdf_title_rejects_junk() -> None:
    """Junk /Title falls through to the next candidate."""
    with tempfile.TemporaryDirectory() as d:
        pdf = Path(d) / "t.pdf"
        make_pdf(pdf, 1)
        orig = convert.pdf_title_from_metadata, convert.pdf_title_from_first_large_line
        try:
            convert.pdf_title_from_metadata = lambda _p: "PowerPoint Presentation"
            convert.pdf_title_from_first_large_line = lambda _p: "Gerçek Başlık"
            check("junk metadata title -> large-line title", derive_pdf_title(pdf) == "Gerçek Başlık")
            convert.pdf_title_from_first_large_line = lambda _p: "******"
            check("all candidates junk -> None (filename fallback)", derive_pdf_title(pdf) is None)
            convert.pdf_title_from_metadata = lambda _p: "Kontrol Teorisi"
            check("good metadata title wins", derive_pdf_title(pdf) == "Kontrol Teorisi")
        finally:
            convert.pdf_title_from_metadata, convert.pdf_title_from_first_large_line = orig


def test_image_cap_warning() -> None:
    """538 found = 400 kept + 86 over_cap + 52 filtered; the numbers must add up."""
    stats = {"found": 538, "kept": 400, "tiny": 30, "unreadable": 2, "template": 20, "over_cap": 86}
    msg = image_cap_warning(stats) or ""
    check("cap warning: total = kept + over_cap (486)", "486" in msg and "538" not in msg)
    check("cap warning: names kept and skipped", "400" in msg and "86" in msg)
    check("cap warning: filtered reported separately", "52" in msg)
    check("no cap hit -> no warning", image_cap_warning({"found": 9, "kept": 5, "tiny": 4, "over_cap": 0}) is None)
    check("cap warning without filtered has no note", "süzüldü" not in (image_cap_warning({"kept": 400, "over_cap": 3}) or ""))


def test_expected_page_count() -> None:
    check("expected_page_count: no range -> total", expected_page_count(8, None) == 8)
    check("expected_page_count: full range", expected_page_count(8, (1, 8)) == 8)
    check("expected_page_count: range past the end is clamped", expected_page_count(8, (3, 20)) == 6)
    check("expected_page_count: start past the end -> 0", expected_page_count(8, (9, 12)) == 0)
    check("expected_page_count: inner range", expected_page_count(8, (2, 4)) == 3)


def test_damaged_propagates_through_escalation() -> None:
    def raise_import(_p):
        raise ImportError("no marker")

    def raise_damaged(_p, page_range=None, backend="default"):
        raise PdfDamagedError("docling 2/8 sayfa döndürdü")

    saved = (
        convert.convert_with_marker, convert.convert_with_docling,
        convert.convert_with_markitdown, convert.looks_broken, convert.pdf_page_count,
    )
    try:
        convert.convert_with_marker = raise_import
        convert.convert_with_docling = raise_damaged
        convert.convert_with_markitdown = lambda _p: "x" * 500  # long enough for the false-positive fallback
        convert.looks_broken = lambda _t, _n: True
        convert.pdf_page_count = lambda _p: 8

        try:
            escalate_pdf(Path("dummy.pdf"))
            outcome = "returned"
        except PdfDamagedError:
            outcome = "damaged"
        except RuntimeError:
            outcome = "runtime"
        check("escalate_pdf lets PdfDamagedError through (not folded into RuntimeError)", outcome == "damaged")

        try:
            route_auto(Path("dummy.pdf"))
            outcome = "returned"
        except PdfDamagedError:
            outcome = "damaged"
        except RuntimeError:
            outcome = "runtime"
        check("route_auto does not fall back to MarkItDown text on PdfDamagedError", outcome == "damaged")
    finally:
        (
            convert.convert_with_marker, convert.convert_with_docling,
            convert.convert_with_markitdown, convert.looks_broken, convert.pdf_page_count,
        ) = saved


def test_is_open_failure() -> None:
    """The #354 fallback decision: only docling's ConversionError saying it
    could not open the document triggers the hybrid retry."""

    class ConversionError(RuntimeError):  # same class name as docling's
        pass

    class Sub(ConversionError):
        pass

    msg = (
        "Conversion failed for: C:/x/original.pdf with status: failure. Errors: "
        "An unexpected error occurred while opening the document C:/x/original.pdf."
    )
    check("_is_open_failure: docling open failure", _is_open_failure(ConversionError(msg)))
    check("_is_open_failure: subclass counts", _is_open_failure(Sub(msg)))
    check("_is_open_failure: other ConversionError", not _is_open_failure(ConversionError("Conversion failed: timeout")))
    check("_is_open_failure: same text, other class", not _is_open_failure(RuntimeError(msg)))
    check("_is_open_failure: ImportError", not _is_open_failure(ImportError("No module named docling")))


def test_backend_forwarded_to_docling() -> None:
    """escalate_pdf and route_explicit hand pdf_backend to convert_with_docling."""
    seen: list[str] = []
    saved = (convert.convert_with_marker, convert.convert_with_docling)
    try:
        convert.convert_with_marker = lambda _p: (_ for _ in ()).throw(ImportError("x"))
        convert.convert_with_docling = lambda _p, page_range=None, backend="default": seen.append(backend) or "md"
        escalate_pdf(Path("d.pdf"), pdf_backend="hybrid")
        convert.route_explicit(Path("d.pdf"), "docling", pdf_backend="hybrid")
        convert.route_explicit(Path("d.pdf"), "docling")
    finally:
        convert.convert_with_marker, convert.convert_with_docling = saved
    check("pdf_backend reaches convert_with_docling (escalate, explicit, default)", seen == ["hybrid", "hybrid", "default"])


def test_cli_pdf_backend() -> None:
    """--pdf-backend is accepted (default/hybrid) and anything else rejected;
    a .md input needs no PDF and no docling."""
    script = Path(__file__).resolve().parent / "convert.py"
    with tempfile.TemporaryDirectory() as tmp:
        md = Path(tmp) / "note.md"
        md.write_text("# Baslik\n\nmetin\n", encoding="utf-8")
        base = [sys.executable, str(script), "--in", str(md), "--out-dir", tmp, "--dry-run"]
        for value in ("default", "hybrid"):
            proc = subprocess.run(base + ["--pdf-backend", value], capture_output=True, text=True, encoding="utf-8")
            check(f"--pdf-backend {value} accepted", proc.returncode == 0 and '"type": "done"' in proc.stdout)
        proc = subprocess.run(base, capture_output=True, text=True, encoding="utf-8")
        check("--pdf-backend optional (default)", proc.returncode == 0)
        proc = subprocess.run(base + ["--pdf-backend", "bogus"], capture_output=True, text=True, encoding="utf-8")
        check("--pdf-backend bogus rejected", proc.returncode != 0 and "invalid choice" in proc.stderr)


def test_reset_run_state() -> None:
    """Per-run globals are cleared between conversions of a long-lived worker."""
    convert._COLUMN_REPAIRED_PAGES.append(3)
    convert._READING_REPAIRED_PAGES.append(4)
    convert._READING_SUSPICIOUS_PAGES.append(5)
    convert._DOCLING_ERRORS.append("x")
    convert._HYBRID_BACKEND_USED[0] = True
    convert._OCR_RAN[0] = True
    convert._PRIMARY_FALLBACK.append("y")
    convert._TEXTLESS_CACHE[("p", 1, 2)] = [1]
    convert.reset_run_state()
    check(
        "reset_run_state clears every per-run global",
        not (
            convert._COLUMN_REPAIRED_PAGES or convert._READING_REPAIRED_PAGES
            or convert._READING_SUSPICIOUS_PAGES or convert._DOCLING_ERRORS
            or convert._HYBRID_BACKEND_USED[0] or convert._OCR_RAN[0]
            or convert._PRIMARY_FALLBACK or convert._TEXTLESS_CACHE
        ),
    )


def test_serve_mode() -> None:
    """--serve: several requests on one process, ids on every event, an `end`
    per request, a failing request does not stop the worker, EOF exits 0.
    Only .md/.py inputs, so no docling is needed."""
    script = Path(__file__).resolve().parent / "convert.py"
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        md = tmp_path / "not.md"
        md.write_text("# Başlık\n\nmetin\n", encoding="utf-8")
        py = tmp_path / "ornek.py"
        py.write_text("print('merhaba')\n", encoding="utf-8")
        out_a, out_b = tmp_path / "out_a", tmp_path / "out_b"
        requests = [
            {"id": "r1", "args": ["--in", str(md), "--out-dir", str(out_a), "--tool", "auto", "--source-name", "şəkil.md"]},
            {"id": "r2", "args": ["--in", str(tmp_path / "yok.md"), "--out-dir", str(out_a)]},
            {"id": "r3", "args": ["--in", str(py), "--out-dir", str(out_b), "--tool", "auto"]},
            {"id": "r4", "args": ["--tool", "bogus"]},
            {"id": "r5", "args": ["--in", str(md), "--out-dir", str(out_b), "--dry-run"]},
        ]
        # Garbage and blank lines are skipped, not fatal.
        payload = "not json\n\n" + "\n".join(json.dumps(r) for r in requests) + "\n"
        proc = subprocess.run(
            [sys.executable, str(script), "--serve"], input=payload.encode("utf-8"), capture_output=True, timeout=120
        )
        check("serve: exits 0 on stdin EOF", proc.returncode == 0)
        events: dict[str, list[dict]] = {}
        for raw in proc.stdout.decode("utf-8").splitlines():
            ev = json.loads(raw)
            events.setdefault(ev.get("id"), []).append(ev)
        check("serve: every event carries an id", None not in events)
        for rid in ("r1", "r2", "r3", "r4", "r5"):
            check(f"serve: {rid} ends with an end event", events.get(rid, [{}])[-1].get("type") == "end")
        types1 = [e["type"] for e in events["r1"]]
        check("serve: r1 progress -> done -> end", types1[0] == "progress" and "done" in types1 and events["r1"][-1]["exit"] == 0)
        done1 = next(e for e in events["r1"] if e["type"] == "done")
        check("serve: r1 wrote its output (non-ASCII source name intact)", Path(done1["outPath"]).exists() and done1["frontmatter"]["source_file"] == "şəkil.md")
        check("serve: r2 (missing file) -> error, exit 1", events["r2"][0]["type"] == "error" and events["r2"][-1]["exit"] == 1)
        check("serve: worker survives the error (r3 converted)", any(e["type"] == "done" for e in events["r3"]) and events["r3"][-1]["exit"] == 0)
        check("serve: r4 (bad args) -> error, exit nonzero", events["r4"][0]["type"] == "error" and events["r4"][-1]["exit"] != 0)
        check("serve: r5 dry-run after the bad args still works", any(e["type"] == "done" and e["outPath"] is None for e in events["r5"]))
        check("serve: no state leak between requests (r5 warnings empty)", next(e for e in events["r5"] if e["type"] == "done")["warnings"] == [])


def _restore(saved: dict) -> None:
    for name, value in saved.items():
        setattr(convert, name, value)


def test_primary_docling_routing() -> None:
    """GPU machine: docling first; MarkItDown only as the fallback."""
    names = ("pdf_primary_tool", "convert_with_docling", "convert_with_markitdown", "convert_with_marker",
             "looks_broken", "pdf_page_count", "textless_pages_in_scope")
    saved = {n: getattr(convert, n) for n in names}
    calls: list[str] = []
    try:
        convert.pdf_primary_tool = lambda: "docling"
        convert.pdf_page_count = lambda _p: 3
        convert.textless_pages_in_scope = lambda _p, _r: []
        convert.looks_broken = lambda _t, _n: False

        convert.convert_with_docling = lambda _p, page_range=None, backend="default": calls.append("docling") or "DOC"
        convert.convert_with_markitdown = lambda _p: calls.append("markitdown") or "MD" * 200
        text, by = route_auto(Path("a.pdf"))
        check("primary docling: docling result, MarkItDown not called", (text, by, calls) == ("DOC", "docling", ["docling"]))

        # docling missing -> MarkItDown; broken text -> marker only, docling not retried
        calls.clear()

        def no_docling(_p, page_range=None, backend="default"):
            calls.append("docling")
            raise ImportError("no docling")

        convert.convert_with_docling = no_docling
        convert.convert_with_marker = lambda _p: calls.append("marker") or (_ for _ in ()).throw(ImportError("no marker"))
        text, by = route_auto(Path("a.pdf"))
        check(
            "primary docling + ImportError: MarkItDown text, docling tried once",
            by == "markitdown" and calls.count("docling") == 1 and convert._PRIMARY_FALLBACK == ["kurulu değil"],
        )

        calls.clear()
        convert.looks_broken = lambda _t, _n: True
        text, by = route_auto(Path("a.pdf"))
        check(
            "primary docling failed + broken MarkItDown text: marker tried, docling NOT retried",
            by == "markitdown" and calls == ["docling", "markitdown", "marker"],
        )

        # nothing salvageable -> RuntimeError naming the docling reason
        convert.convert_with_markitdown = lambda _p: "tiny"
        try:
            route_auto(Path("a.pdf"))
            outcome = "returned"
        except RuntimeError as err:
            outcome = "docling: kurulu değil" in str(err)
        check("primary docling failed + empty MarkItDown: RuntimeError names docling reason", outcome is True)

        # other docling failure is recorded, not raised
        convert.looks_broken = lambda _t, _n: False
        convert.convert_with_markitdown = lambda _p: "MD" * 200
        convert.convert_with_docling = lambda _p, page_range=None, backend="default": (_ for _ in ()).throw(RuntimeError("CUDA out of memory\nsatır 2"))
        text, by = route_auto(Path("a.pdf"))
        check("primary docling + RuntimeError: recorded (first line), MarkItDown used", by == "markitdown" and convert._PRIMARY_FALLBACK == ["CUDA out of memory"])

        # damaged propagates
        def damaged(_p, page_range=None, backend="default"):
            raise PdfDamagedError("1/3")

        convert.convert_with_docling = damaged
        try:
            route_auto(Path("a.pdf"))
            outcome = "returned"
        except PdfDamagedError:
            outcome = "damaged"
        except Exception:  # noqa: BLE001
            outcome = "other"
        check("primary docling + PdfDamagedError propagates", outcome == "damaged")

        # state cleared at the start of each call
        convert._PRIMARY_FALLBACK.append("eski")
        convert.pdf_primary_tool = lambda: "markitdown"
        route_auto(Path("a.pdf"))
        check("_PRIMARY_FALLBACK cleared per route_auto call", convert._PRIMARY_FALLBACK == [])
    finally:
        _restore(saved)
        convert._PRIMARY_FALLBACK.clear()


def test_primary_markitdown_routing() -> None:
    names = ("pdf_primary_tool", "convert_with_docling", "convert_with_markitdown", "convert_with_marker",
             "looks_broken", "pdf_page_count", "textless_pages_in_scope")
    saved = {n: getattr(convert, n) for n in names}
    calls: list[str] = []
    try:
        convert.pdf_primary_tool = lambda: "markitdown"
        convert.pdf_page_count = lambda _p: 2
        convert.looks_broken = lambda _t, _n: False
        convert.convert_with_markitdown = lambda _p: calls.append("markitdown") or "MD" * 200
        convert.convert_with_marker = lambda _p: calls.append("marker") or (_ for _ in ()).throw(ImportError("x"))
        convert.convert_with_docling = lambda _p, page_range=None, backend="default": calls.append("docling") or "DOC"

        convert.textless_pages_in_scope = lambda _p, _r: []
        text, by = route_auto(Path("a.pdf"))
        check("primary markitdown, no textless pages, not broken: stays MarkItDown", by == "markitdown" and calls == ["markitdown"])

        calls.clear()
        convert.textless_pages_in_scope = lambda _p, _r: [2]
        text, by = route_auto(Path("a.pdf"))
        check("primary markitdown + textless page: escalates (marker then docling)", by == "docling" and calls == ["markitdown", "marker", "docling"])
    finally:
        _restore(saved)


def test_pdf_primary_override() -> None:
    saved_env = os.environ.get("VC_PDF_PRIMARY")
    saved_acc = convert.accelerator_available
    try:
        convert.accelerator_available = lambda: True
        results = {}
        for value in (None, "docling", "MarkItDown", " markitdown ", "bogus", ""):
            if value is None:
                os.environ.pop("VC_PDF_PRIMARY", None)
            else:
                os.environ["VC_PDF_PRIMARY"] = value
            results[value] = convert.pdf_primary_tool()
        check("VC_PDF_PRIMARY: unset/bogus/empty -> auto (docling with accelerator)",
              results[None] == results["bogus"] == results[""] == "docling")
        check("VC_PDF_PRIMARY: explicit values are case/space-insensitive",
              results["docling"] == "docling" and results["MarkItDown"] == "markitdown" and results[" markitdown "] == "markitdown")
        convert.accelerator_available = lambda: False
        os.environ.pop("VC_PDF_PRIMARY", None)
        check("no accelerator -> markitdown first", convert.pdf_primary_tool() == "markitdown")
        os.environ["VC_PDF_PRIMARY"] = "docling"
        check("VC_PDF_PRIMARY=docling wins without accelerator", convert.pdf_primary_tool() == "docling")
    finally:
        convert.accelerator_available = saved_acc
        if saved_env is None:
            os.environ.pop("VC_PDF_PRIMARY", None)
        else:
            os.environ["VC_PDF_PRIMARY"] = saved_env
    check("accelerator_available returns a bool", isinstance(convert.accelerator_available(), bool))


def test_hf_offline_first() -> None:
    saved_env = os.environ.get("HF_HUB_OFFLINE")
    saved_stderr = sys.stderr
    try:
        sys.stderr = io.StringIO()
        # 1. user already set it: respected, no retry even on an offline-miss error
        for user_value in ("0", "1"):
            os.environ["HF_HUB_OFFLINE"] = user_value
            n = {"calls": 0}

            def miss_user():
                n["calls"] += 1
                raise OSError("outgoing traffic has been disabled")

            try:
                convert.hf_offline_first(miss_user)
            except OSError:
                pass
            check(f"HF_HUB_OFFLINE={user_value} set by user: untouched, no retry",
                  n["calls"] == 1 and os.environ["HF_HUB_OFFLINE"] == user_value)

        # 2. we set it; success keeps it for the process
        os.environ.pop("HF_HUB_OFFLINE", None)
        seen: list[str | None] = []
        out = convert.hf_offline_first(lambda: seen.append(os.environ.get("HF_HUB_OFFLINE")) or "ok")
        check("we set HF_HUB_OFFLINE=1 for the run", out == "ok" and seen == ["1"])

        # 3. offline-miss error -> exactly one online retry, flag removed
        class LocalEntryNotFoundError(FileNotFoundError):
            pass

        os.environ.pop("HF_HUB_OFFLINE", None)
        seen = []

        def flaky():
            seen.append(os.environ.get("HF_HUB_OFFLINE"))
            if len(seen) == 1:
                raise RuntimeError("wrapped") from LocalEntryNotFoundError("Cannot find ...")
            return "second"

        out = convert.hf_offline_first(flaky)
        check("offline miss (chained LocalEntryNotFoundError): one online retry", out == "second" and seen == ["1", None])
        check("online retry announces model download on stderr", "indiriliyor" in sys.stderr.getvalue())

        # 4. second failure propagates (no third attempt)
        os.environ.pop("HF_HUB_OFFLINE", None)
        n = {"calls": 0}

        def always_miss():
            n["calls"] += 1
            raise OSError("We couldn't connect to 'https://huggingface.co' to load the files")

        try:
            convert.hf_offline_first(always_miss)
            outcome = "returned"
        except OSError:
            outcome = "raised"
        check("retry happens exactly once", outcome == "raised" and n["calls"] == 2)

        # 5. unrelated error: no retry
        os.environ.pop("HF_HUB_OFFLINE", None)
        n = {"calls": 0}

        def other():
            n["calls"] += 1
            raise ValueError("bozuk PDF")

        try:
            convert.hf_offline_first(other)
        except ValueError:
            pass
        check("unrelated error: no retry", n["calls"] == 1)
    finally:
        sys.stderr = saved_stderr
        if saved_env is None:
            os.environ.pop("HF_HUB_OFFLINE", None)
        else:
            os.environ["HF_HUB_OFFLINE"] = saved_env
        convert._set_hf_offline_constant(saved_env in ("1", "true", "True"))

    check("_is_hf_offline_miss: OfflineModeIsEnabled by class name",
          convert._is_hf_offline_miss(type("OfflineModeIsEnabled", (ConnectionError,), {})("x")))
    check("_is_hf_offline_miss: plain error is not one", not convert._is_hf_offline_miss(RuntimeError("CUDA out of memory")))


def test_ocr_segments() -> None:
    """Per-page OCR: contiguous textless runs get OCR, the rest do not."""
    seg = convert.ocr_segments
    check("ocr_segments: no textless -> one non-OCR segment", seg((1, 12), []) == [(1, 12, False)])
    check("ocr_segments: cover only", seg((1, 12), [1]) == [(1, 1, True), (2, 12, False)])
    check("ocr_segments: last page only", seg((1, 12), {12}) == [(1, 11, False), (12, 12, True)])
    check(
        "ocr_segments: alternating pages",
        seg((1, 5), [2, 4]) == [(1, 1, False), (2, 2, True), (3, 3, False), (4, 4, True), (5, 5, False)],
    )
    check("ocr_segments: contiguous run is one segment", seg((1, 6), [3, 4]) == [(1, 2, False), (3, 4, True), (5, 6, False)])
    check("ocr_segments: all pages textless -> one OCR segment", seg((1, 4), [1, 2, 3, 4]) == [(1, 4, True)])
    check(
        "ocr_segments: range not starting at 1, outside pages ignored",
        seg((5, 8), [1, 2, 6, 20]) == [(5, 5, False), (6, 6, True), (7, 8, False)],
    )
    check("ocr_segments: range starting on a textless page", seg((3, 6), [3, 4]) == [(3, 4, True), (5, 6, False)])
    check("ocr_segments: single page", seg((7, 7), [7]) == [(7, 7, True)] and seg((7, 7), []) == [(7, 7, False)])
    check("ocr_segments: segments tile the range exactly", all(
        a[1] + 1 == b[0] for a, b in zip(seg((1, 30), [2, 3, 9, 30]), seg((1, 30), [2, 3, 9, 30])[1:])
    ))


def test_chunk_segments() -> None:
    """Long PDFs are converted in chunks of at most N pages."""
    ch = convert.chunk_segments
    check("chunk_segments: short segment untouched", ch([(1, 150, False)], 150) == [(1, 150, False)])
    check("chunk_segments: 151 pages -> 150 + 1", ch([(1, 151, False)], 150) == [(1, 150, False), (151, 151, False)])
    check(
        "chunk_segments: OCR flag kept, each segment split on its own",
        ch([(1, 2, True), (3, 9, False)], 3) == [(1, 2, True), (3, 5, False), (6, 8, False), (9, 9, False)],
    )
    tiles = ch([(5, 1000, True)], 150)
    check("chunk_segments: pieces tile the range", tiles[0][0] == 5 and tiles[-1][1] == 1000
          and all(a[1] + 1 == b[0] for a, b in zip(tiles, tiles[1:])) and all(e - s < 150 for s, e, _o in tiles))
    check("chunk_segments: empty", ch([], 150) == [])
    saved = os.environ.get("VC_PDF_CHUNK_PAGES")
    try:
        os.environ["VC_PDF_CHUNK_PAGES"] = "40"
        check("pdf_chunk_pages: env override", convert.pdf_chunk_pages() == 40)
        os.environ["VC_PDF_CHUNK_PAGES"] = "x"
        check("pdf_chunk_pages: junk -> default", convert.pdf_chunk_pages() == convert.PDF_CHUNK_PAGES)
        os.environ["VC_PDF_CHUNK_PAGES"] = "0"
        check("pdf_chunk_pages: never below 1", convert.pdf_chunk_pages() == 1)
    finally:
        if saved is None:
            os.environ.pop("VC_PDF_CHUNK_PAGES", None)
        else:
            os.environ["VC_PDF_CHUNK_PAGES"] = saved


def test_concatenate_keep_pages() -> None:
    """Merging chunk documents keeps the real page numbers, also when docling
    dropped the last page of a chunk (concatenate alone would shift them)."""
    try:
        from docling_core.types.doc import BoundingBox, DoclingDocument, ProvenanceItem, Size
    except ImportError:
        print("SKIP  _concatenate_keep_pages: docling_core kurulu değil")
        return

    def doc(pages: list[int]) -> DoclingDocument:
        d = DoclingDocument(name="t")
        for p in pages:
            d.add_page(page_no=p, size=Size(width=100, height=100))
            d.add_text(label="text", text=f"sayfa {p}",
                       prov=ProvenanceItem(page_no=p, bbox=BoundingBox(l=0, t=0, r=1, b=1), charspan=(0, 1)))
        return d

    def prov_pages(d) -> list[int]:
        return [t.prov[0].page_no for t in d.texts]

    merged = convert._concatenate_keep_pages([doc([1, 2, 3]), doc([4, 5])])
    check("_concatenate_keep_pages: contiguous chunks", sorted(merged.pages) == [1, 2, 3, 4, 5]
          and prov_pages(merged) == [1, 2, 3, 4, 5])
    # Page 3 missing from the first chunk: plain concatenate would renumber 4,5 -> 3,4.
    merged = convert._concatenate_keep_pages([doc([1, 2]), doc([4, 5])])
    check("_concatenate_keep_pages: dropped last page does not shift later pages",
          sorted(merged.pages) == [1, 2, 4, 5] and prov_pages(merged) == [1, 2, 4, 5]
          and all(merged.pages[n].page_no == n for n in merged.pages))
    merged = convert._concatenate_keep_pages([doc([151, 152]), doc([153])])
    check("_concatenate_keep_pages: range not starting at 1", prov_pages(merged) == [151, 152, 153])


def test_textless_warning() -> None:
    w = convert.textless_warning
    check("textless_warning: docling + OCR ran -> OCR ile okundu", "OCR ile okundu" in (w("docling", [2], True) or ""))
    check("textless_warning: docling without OCR -> content missing", "içeriği notta eksik" in (w("docling", [2], False) or ""))
    check("textless_warning: markitdown -> content missing", "içeriği notta eksik" in (w("markitdown", [2, 3], True) or ""))
    check("textless_warning: no pages / other tools -> None", w("docling", [], True) is None and w("pandoc", [1], False) is None)
    check("textless_warning: long list shortened", "…" in (w("markitdown", list(range(1, 20)), False) or ""))


def test_textless_pages() -> None:
    from pypdf import PdfWriter

    with tempfile.TemporaryDirectory() as d:
        pdf = Path(d) / "mixed.pdf"
        # Page 1 has real text (drawn via a content stream); page 2 is blank.
        from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

        w = PdfWriter()
        page = w.add_blank_page(width=300, height=300)
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 14 Tf 20 150 Td (This page has a real text layer.) Tj ET")
        page[NameObject("/Contents")] = w._add_object(stream)
        font_obj = w._add_object(DictionaryObject({
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }))
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_obj})
        })
        w.add_blank_page(width=300, height=300)  # truly blank: no text, no image
        # Page 3: image only (a "scan"), built from a one-page PIL PDF.
        from PIL import Image

        img_pdf = Path(d) / "img.pdf"
        Image.new("RGB", (100, 100), "red").save(str(img_pdf))
        from pypdf import PdfReader

        w.add_page(PdfReader(str(img_pdf)).pages[0])
        with pdf.open("wb") as f:
            w.write(f)

        check("textless_pages: blank page 2 NOT flagged, image-only page 3 flagged", convert.textless_pages(pdf) == [3])
        check("textless_pages_in_scope respects --pages", convert.textless_pages_in_scope(pdf, (1, 1)) == [])
        check("textless_pages_in_scope: range covering the image page", convert.textless_pages_in_scope(pdf, (3, 3)) == [3])
        check("textless_pages: result is cached per path", len(convert._TEXTLESS_CACHE) >= 1)
        check("textless_pages: unreadable file -> []", convert.textless_pages(Path(d) / "yok.pdf") == [])
        junk = Path(d) / "junk.pdf"
        junk.write_bytes(b"not a pdf")
        check("textless_pages: corrupt file -> []", convert.textless_pages(junk) == [])

    # Optional real-file check: set VAULT_CHAT_TEST_PDF_DIR to a folder holding this PDF.
    real = Path(os.environ.get("VAULT_CHAT_TEST_PDF_DIR", "<unset>")) / "e5f819f98b7ab0e42a38ff9ef5960c0d_exam4sol.pdf"
    if real.exists():
        check("textless_pages: exam4sol.pdf (page 2 scanned) -> [2]", convert.textless_pages(real) == [2])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    test_title_from_fragments()
    test_demote_slide_headings()
    test_clean_pptx_noise()
    test_unique_output_path()
    test_split_existing_frontmatter()
    test_parse_page_range()
    test_looks_broken_unaffected_by_this_pass()
    test_convert_code_file()
    test_pdf_damage_checks()
    test_expected_page_count()
    test_scanned_pdf_not_damaged()
    test_image_cap_warning()
    test_pdf_title_rejects_junk()
    test_damaged_propagates_through_escalation()
    test_is_open_failure()
    test_backend_forwarded_to_docling()
    test_cli_pdf_backend()
    test_primary_docling_routing()
    test_primary_markitdown_routing()
    test_pdf_primary_override()
    test_hf_offline_first()
    test_textless_pages()
    test_textless_warning()
    test_ocr_segments()
    test_chunk_segments()
    test_concatenate_keep_pages()
    test_reset_run_state()
    test_serve_mode()
    print(f"\n{len(failures)} başarısız" if failures else "\nhepsi geçti")
    sys.exit(1 if failures else 0)
