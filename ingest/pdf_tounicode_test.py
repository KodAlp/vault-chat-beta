# -*- coding: utf-8 -*-
"""Tests for pdf_tounicode.py (corrected /ToUnicode for old TeX PDFs).

    python ingest/pdf_tounicode_test.py

Not part of `npm test`. Every check exists because of a measured failure
(2026-10-08, MIT OCW course PDFs): CMSY/CMMI/CMR fonts whose /ToUnicode maps
primes, Delta, <= to U+FFFD and the infinity glyph to U+2248 (≈), so notes read
"f � (x)" and "-≈ < x < ≈". The synthetic fonts below embed only the cleartext
part of a Type1 program (code -> glyph name table, as pdfTeX writes it); the
real unit2_review.pdf check at the end runs only when that file exists.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pypdf  # noqa: E402
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject  # noqa: E402

import pdf_tounicode as P  # noqa: E402

failures: list[str] = []
FFFD = "\ufffd"
SOFT_HYPHEN = "\u00ad"


def check(name: str, ok: bool) -> None:
    print(("PASS  " if ok else "FAIL  ") + name)
    if not ok:
        failures.append(name)


def font(base: str, tounicode: dict[int, str] | None, names: dict[int, str] | None = None, w=None) -> DictionaryObject:
    """With a writer, streams become indirect objects (a direct stream is not valid PDF)."""
    ind = (lambda o: w._add_object(o)) if w is not None else (lambda o: o)
    d = DictionaryObject()
    d[NameObject("/Type")] = NameObject("/Font")
    d[NameObject("/Subtype")] = NameObject("/Type1")
    d[NameObject("/BaseFont")] = NameObject("/" + base)
    if tounicode is not None:
        s = DecodedStreamObject()
        s.set_data(P.build_tounicode(tounicode))
        d[NameObject("/ToUnicode")] = ind(s)
    if names:
        clear = b"%!PS-AdobeFont-1.0: X\n/Encoding 256 array\n" + b"".join(
            b"dup %d /%s put\n" % (c, n.encode()) for c, n in names.items()
        ) + b"readonly def\ncurrentfile eexec\n"
        ff = DecodedStreamObject()
        ff.set_data(clear)
        ff[NameObject("/Length1")] = NumberObject(len(clear))
        fd = DictionaryObject()
        fd[NameObject("/FontName")] = NameObject("/" + base)
        fd[NameObject("/FontFile")] = ind(ff)
        d[NameObject("/FontDescriptor")] = ind(fd)
    return d


SY = {0x30: "prime", 0x31: "infinity", 0x00: "minus", 0x19: "approxequal"}


def test_tables() -> None:
    check("OMS 0x30 is prime", P.OMS[0x30] == "′")
    check("OMS 0x31 is infinity", P.OMS[0x31] == "∞")
    check("OT1 0x01 is Delta (Greek, not the increment sign)", P.OT1[0x01] == "Δ")
    check("subset prefix and size digits are ignored", P.family_table("ABCDEF+CMSY10") is P.OMS)
    check("AMS / picture fonts are not CM family", P.family_table("MSBM10") is None and P.family_table("LINE10") is None)
    check("Adobe Delta resolves to Greek Delta", P.glyph_name_to_unicode("Delta") == "Δ")
    check("prime resolves (AGL calls it minute)", P.glyph_name_to_unicode("prime") == "′")
    check("cmex integraldisplay resolves", P.glyph_name_to_unicode("integraldisplay") == "∫")
    check("extensible piece stays unresolved", P.glyph_name_to_unicode("vextendsingle") is None)


def test_detection() -> None:
    good = font("CMSY10", {0x30: "′", 0x31: "∞", 0x00: "−", 0x19: "≈"}, SY)
    check("correct ToUnicode is never touched", P.plan_font(good) is None)

    bad = font("ABCDEF+CMSY10", {0x00: "−", 0x30: FFFD, 0x31: "≈"}, SY)
    plan = P.plan_font(bad)
    check("U+FFFD and the wrong ≈ are corrected", plan is not None and plan[0x30] == "′" and plan[0x31] == "∞")
    check("a code that already agreed keeps its mapping", plan is not None and plan[0x00] == "−")

    only_hyphen = font("CMR10", {0x2D: SOFT_HYPHEN, 0x0C: "fi"}, {0x2D: "hyphen", 0x0C: "fi"})
    check("hyphen / ligature variants count as agreement", P.plan_font(only_hyphen) is None)

    mp = P.plan_font(font("CMSY10", None, SY))
    check("no ToUnicode + symbol glyphs -> patched", mp is not None and mp[0x30] == "′")

    plain = font("CMR10", None, {0x41: "A", 0x66: "f", 0x0C: "fi", 0x27: "quoteright"})
    check("no ToUnicode + plain text font -> left alone", P.plan_font(plain) is None)
    check("no ToUnicode and no readable glyph names -> left alone", P.plan_font(font("CMSY10", None)) is None)
    check("non-CM font is never touched", P.plan_font(font("Times-Roman", {0x41: FFFD}, {0x41: "A"})) is None)

    unresolved = P.plan_font(font("CMEX10", {0x0C: FFFD}, {0x0C: "vextendsingle", 0x5A: "integraldisplay"}))
    check("glyph without a character stays as it was, resolvable one is fixed",
          unresolved is not None and unresolved[0x0C] == FFFD and unresolved[0x5A] == "∫")
    unres2 = P.plan_font(font("CMEX10", {0x5A: FFFD}, {0x0C: "vextendsingle", 0x5A: "integraldisplay"}))
    check("an unresolvable code with no entry is not given one", unres2 is not None and 0x0C not in unres2)

    two_byte = font("CMSY10", None, SY)
    s = DecodedStreamObject()
    s.set_data(b"begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0030> <FFFD> endbfchar endcmap")
    two_byte[NameObject("/ToUnicode")] = s
    check("a two-byte CMap is not merged into", P.plan_font(two_byte) is None)

    check("CMap round trip", P.parse_tounicode(P.build_tounicode({1: "Δ", 0x30: "′"})) == {1: "Δ", 0x30: "′"})
    rng = P.parse_tounicode(b"begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <41> <43> <0061> endbfrange")
    check("bfrange parsing", rng == {0x41: "a", 0x42: "b", 0x43: "c"})


def make_pdf(path: Path, tounicode: dict[int, str] | None) -> None:
    """One page that draws code 0x31 then 0x30 of a CMSY10 font (∞ and a prime)."""
    w = pypdf.PdfWriter()
    page = w.add_blank_page(200, 200)
    fonts = DictionaryObject()
    fonts[NameObject("/F1")] = w._add_object(font("CMSY10", tounicode, SY, w))
    res = DictionaryObject()
    res[NameObject("/Font")] = fonts
    page[NameObject("/Resources")] = res
    content = DecodedStreamObject()
    content.set_data(b"BT /F1 12 Tf 20 100 Td (10) Tj ET")
    page[NameObject("/Contents")] = w._add_object(content)
    with open(path, "wb") as fh:
        w.write(fh)


def extract(path) -> str:
    from pdfminer.high_level import extract_text

    return extract_text(str(path))


def test_patched_copy() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / "tex.pdf"
        make_pdf(src, {0x30: FFFD, 0x31: "≈"})
        before = src.read_bytes()
        t0 = extract(src)
        check("synthetic PDF reads wrong before the fix", "≈" in t0 and FFFD in t0)
        work = tmp / "work"
        work.mkdir()
        out, stats = P.prepare_pdf(src, work)
        text = extract(out)
        check("copy reads ∞ and prime", "∞" in text and "′" in text and "≈" not in text and FFFD not in text)
        check("stats count the font and its corrected codes", stats["fonts"] == 1 and stats["codes"] >= 2)
        check("copy is written inside the work dir", Path(out).parent == work and Path(out) != src)
        check("input file is byte-identical afterwards", src.read_bytes() == before)

        good = tmp / "good.pdf"
        make_pdf(good, {0x30: "′", 0x31: "∞", 0x00: "−", 0x19: "≈"})
        work2 = tmp / "work2"
        work2.mkdir()
        out2, stats2 = P.prepare_pdf(good, work2)
        check("correct PDF: original returned, nothing written",
              Path(out2) == good and stats2["fonts"] == 0 and not any(work2.iterdir()))

        junk = tmp / "junk.pdf"
        junk.write_bytes(b"%PDF-1.4\nthis is not a pdf at all")
        out4, stats4 = P.prepare_pdf(junk, work)
        check("corrupt PDF falls back to the original", Path(out4) == junk and stats4["fonts"] == 0)
        trunc = tmp / "trunc.pdf"
        trunc.write_bytes(before[:300])
        out5, _ = P.prepare_pdf(trunc, work)
        check("truncated PDF falls back to the original", Path(out5) == trunc)
        out6, _ = P.prepare_pdf(tmp / "missing.pdf", work)
        check("missing file falls back instead of raising", Path(out6) == tmp / "missing.pdf")


UNIT2 = Path(r"C:\Users\Alp\Desktop\Notebook verileri\Matematik\static_resources\942f311e64cea77db589a3557b062025_unit2_review.pdf")


def test_end_to_end() -> None:
    if not UNIT2.exists():
        print("SKIP  unit2_review.pdf not found")
        return
    before = set(Path(tempfile.gettempdir()).glob("vault-chat-tounicode-*"))
    with tempfile.TemporaryDirectory() as tmp:
        proc = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parent / "convert.py"), "--in", str(UNIT2), "--out-dir", tmp,
             "--tool", "markitdown", "--no-images", "--source-name", "unit2_review.pdf"],
            capture_output=True, text=True, encoding="utf-8",
        )
        done = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")][-1]
        md = Path(done["outPath"]).read_text(encoding="utf-8")
        check("end to end: no U+FFFD left", FFFD not in md)
        check("end to end: 8 ∞ and the 5 genuine ≈ survive", md.count("∞") == 8 and md.count("≈") == 5)
        check("end to end: informational note present", sum("onarıldı" in w for w in done["warnings"]) == 1)
        check("end to end: no bozuk-karakter warning", not any("bozuk karakter" in w for w in done["warnings"]))
    after = set(Path(tempfile.gettempdir()).glob("vault-chat-tounicode-*"))
    check("end to end: temp copy removed after the run", not (after - before))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    test_tables()
    test_detection()
    test_patched_copy()
    test_end_to_end()
    print(f"\n{len(failures)} başarısız" if failures else "\nhepsi geçti")
    sys.exit(1 if failures else 0)
