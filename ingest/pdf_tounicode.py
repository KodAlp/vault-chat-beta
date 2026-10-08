"""Give old TeX PDFs a correct /ToUnicode so every converter reads them right.

Why (measured 2026-10-08 on MIT OCW course PDFs): pdfTeX and dvips+Ghostscript
files embed the Computer Modern fonts (CMSY, CMMI, CMR, CMEX ...) and every
extractor (pdfium, docling-parse, pdfminer) gives U+FFFD for primes, Delta,
<=, >=, big integral signs ... In 942f311e..._unit2_review.pdf the /ToUnicode
CMap of CMSY10 maps every code except 0x00 to U+FFFD, and maps 0x31 (infinity)
to U+2248 (the approximately-equal sign) -- that is where "-≈ < x < ≈" comes
from: a wrong but valid character, so no U+FFFD check ever sees it. A scan of
702 course PDFs found 67 with U+FFFD in the first 15 pages.

A Markdown post-pass (context matching) was measured first and repaired only
66% (docling) / 42% (MarkItDown) of the U+FFFD, because docling moves and
re-reads display equations. Fixing the source does not depend on any of that:
the embedded font program knows what each glyph is (glyph names such as
"prime", "infinity", "Delta" in the Type1 /Encoding array, the CFF Encoding, or
the font dictionary's /Differences). We read those names, map them to Unicode
(Adobe Glyph List + the name lists below), and write a copy of the PDF whose
/ToUnicode agrees with them. On the 10-PDF sample U+FFFD went 116 -> 8 with
docling and 1148 -> 32 with MarkItDown (the rest: LaTeX line-drawing glyphs
and extensible bracket pieces, which have no character).

Conservative by design:
  * only CM-family fonts (BaseFont CMSY/CMMI/CMR/CMBX/CMTI/CMEX ..., subset
    prefix ignored) are looked at; AMS symbol fonts (MSBM: names like "R" for
    blackboard bold) and LaTeX picture fonts (LINE10) are never touched;
  * a font is patched only if its existing /ToUnicode disagrees with the glyph
    names on at least one code (missing entry, U+FFFD, or a different
    character; hyphen/quote/ligature variants count as agreement) -- or, when
    it has no /ToUnicode at all, if its glyphs include anything beyond plain
    ASCII (so a plain-text CMR font stays as it is);
  * only the disagreeing codes are overwritten; every other existing mapping is
    kept, and a code whose glyph has no single-character meaning stays U+FFFD
    (never a guess);
  * the input file is never modified: the corrected copy is written elsewhere
    and the caller deletes it. No qualifying font -> no copy is written.
"""

from __future__ import annotations

import io
import re
import unicodedata
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# TeX font encodings (code -> unicode). Missing code = no safe single answer.
# ---------------------------------------------------------------------------

# OMS (cmsy), codes 0x00-0x7F. Calligraphic capitals 0x41-0x5A are left out on
# purpose: a plain "A" would silently change meaning (\mathcal{A}); 0x36 is the
# combining negation slash, which cannot stand alone.
_OMS_LOW = "−·×∗÷⋄±∓⊕⊖⊗⊘⊙○∘∙≍≡⊆⊇≤≥⪯⪰∼≈⊂⊃≪≫≺≻←→↑↓↔↗↘≃⇐⇒⇑⇓⇔↖↙∝′∞∈∋△▽̸↦∀∃¬∅ℜℑ⊤⊥ℵ"
_OMS_HIGH = "∪∩⊎∧∨⊢⊣⌊⌋⌈⌉{}⟨⟩|∥↕⇕\\≀√∐∇∫⊔⊓⊑⊒§†‡¶♣♢♡♠"

OMS = {i: ch for i, ch in enumerate(_OMS_LOW)}
OMS.update({0x5B + i: ch for i, ch in enumerate(_OMS_HIGH)})
del OMS[0x36]

# OML (cmmi). 0x0F is \epsilon (3-shaped), 0x22 \varepsilon (lunate),
# 0x1E \phi (stroked), 0x27 \varphi (loop): Adobe's glyph names for these four
# codes are the other way round (names say phi/epsilon where the shapes differ),
# which is why the survey found 4 name/table disagreements; the name wins in
# font_truth() and both variants are the same letter for a reader.
_OML_GREEK_UP = "ΓΔΘΛΞΠΣΥΦΨΩ"
_OML_GREEK_LO = "αβγδεζηθικλμνξπρστυϕχψωϵϑϖϱςφ"  # 0x0B .. 0x27
_OML_ARROWS = "↼↽⇀⇁"  # 0x28..0x2B
OML = {i: ch for i, ch in enumerate(_OML_GREEK_UP)}
OML.update({0x0B + i: ch for i, ch in enumerate(_OML_GREEK_LO)})
OML.update({0x28 + i: ch for i, ch in enumerate(_OML_ARROWS)})
OML.update({0x30 + i: str(i) for i in range(10)})
OML.update({0x3A: ".", 0x3B: ",", 0x3C: "<", 0x3D: "/", 0x3E: ">", 0x3F: "⋆", 0x40: "∂"})
OML.update({0x41 + i: chr(ord("A") + i) for i in range(26)})
OML.update({0x61 + i: chr(ord("a") + i) for i in range(26)})
OML.update({0x5B: "♭", 0x5C: "♮", 0x5D: "♯", 0x5E: "⌣", 0x5F: "⌢", 0x60: "ℓ", 0x7B: "ı", 0x7C: "ȷ", 0x7D: "℘"})

# OT1 (cmr, cmbx, cmti ...).
OT1 = {i: ch for i, ch in enumerate(_OML_GREEK_UP)}
OT1.update({0x0B: "ﬀ", 0x0C: "ﬁ", 0x0D: "ﬂ", 0x0E: "ﬃ", 0x0F: "ﬄ", 0x10: "ı", 0x11: "ȷ"})
OT1.update({0x19: "ß", 0x1A: "æ", 0x1B: "œ", 0x1C: "ø", 0x1D: "Æ", 0x1E: "Œ", 0x1F: "Ø"})
OT1.update({0x21: "!", 0x22: "”", 0x23: "#", 0x24: "$", 0x25: "%", 0x26: "&", 0x27: "’"})
OT1.update({0x28: "(", 0x29: ")", 0x2A: "*", 0x2B: "+", 0x2C: ",", 0x2D: "-", 0x2E: ".", 0x2F: "/"})
OT1.update({0x30 + i: str(i) for i in range(10)})
OT1.update({0x3A: ":", 0x3B: ";", 0x3C: "¡", 0x3D: "=", 0x3E: "¿", 0x3F: "?", 0x40: "@"})
OT1.update({0x41 + i: chr(ord("A") + i) for i in range(26)})
OT1.update({0x5B: "[", 0x5C: "“", 0x5D: "]", 0x60: "‘"})
OT1.update({0x61 + i: chr(ord("a") + i) for i in range(26)})
OT1.update({0x7B: "–", 0x7C: "—"})

# Font base name (subset prefix and size digits stripped) -> table. CMEX (OMX)
# has no table: its glyph names are all it needs (see _OMX_STEMS).
_FAMILY = {
    "CMSY": OMS, "CMBSY": OMS, "CMEX": {},
    "CMMI": OML, "CMMIB": OML,
    "CMR": OT1, "CMBX": OT1, "CMTI": OT1, "CMSL": OT1, "CMSS": OT1, "CMSSBX": OT1,
    "CMSSI": OT1, "CMSSSL": OT1, "CMCSC": OT1, "CMBXTI": OT1, "CMBXSL": OT1, "CMB": OT1,
}


def family_table(basefont: str) -> dict[int, str] | None:
    name = re.sub(r"^[A-Z]{6}\+", "", basefont.lstrip("/"))
    m = re.match(r"^([A-Za-z]+?)(\d+.*)?$", name)
    return _FAMILY.get(m.group(1).upper()) if m else None



# ---------------------------------------------------------------------------
# Glyph names from the embedded font programs
# ---------------------------------------------------------------------------

_DUP_RE = re.compile(rb"dup\s+(?:(\d+)#)?([0-9A-Fa-f]+)\s*/([^\s/\[\]{}()<>%]+)\s+put")

# The Adobe Glyph List maps Delta/Omega/mu to the "increment"/"ohm"/"micro"
# compatibility code points; the Greek letters are what the text means.
_CANON = {"∆": "Δ", "Ω": "Ω", "µ": "μ"}

# cmex10 (OMX) glyph names are Adobe-style but not in the Adobe Glyph List:
# parenleftbig, summationdisplay, radicalBigg ... Size suffixes are dropped.
# Extensible pieces (arrowvertex, vextendsingle/double, brace tips, *tp/*bt/*ex)
# have no single-character meaning (a tall bar is built from several of them:
# measured 8 stacked pieces in one evaluation bar) and stay unresolved.
_OMX_STEMS = {
    "parenleft": "(", "parenright": ")", "bracketleft": "[", "bracketright": "]",
    "braceleft": "{", "braceright": "}", "angbracketleft": "⟨", "angbracketright": "⟩",
    "floorleft": "⌊", "floorright": "⌋", "ceilingleft": "⌈", "ceilingright": "⌉",
    "summation": "∑", "product": "∏",
    "coproduct": "∐", "integral": "∫", "contintegral": "∮", "union": "⋃",
    "intersection": "⋂", "radical": "√",
}
_OMX_RE = re.compile(r"^([a-z]+?)(?:big|Big|bigg|Bigg|display|text)?$")

# Names the font programs use that the Adobe Glyph List lacks ("prime" is AGL
# "minute"). Compiled from the unresolved-name survey of 2381 embedded CM fonts.
_TEX_NAMES = {
    "prime": "′", "circlecopyrt": "○", "lessmuch": "≪", "greatermuch": "≫",
    "lscript": "ℓ", "star": "⋆", "flat": "♭", "natural": "♮", "sharp": "♯",
    "slurbelow": "⌣", "slurabove": "⌢", "arrowrighttophalf": "⇀", "arrowhookleft": "↩",
    "arrowhookright": "↪", "diamondmath": "⋄", "circledot": "⊙",
    "precedesequal": "⪯", "followsequal": "⪰", "follows": "≻", "arrownortheast": "↗",
    "arrowsoutheast": "↘", "arrowsouthwest": "↙", "similarequal": "≃", "owner": "∋",
    "triangle": "△", "mapsto": "↦", "Rfractur": "ℜ", "Ifractur": "ℑ",
    "latticetop": "⊤", "turnstileleft": "⊢", "turnstileright": "⊣", "bardbl": "∥",
    "arrowdblbothv": "⇕", "unionsq": "⊔", "subsetsqequal": "⊑",
    "epsilon1": "ε", "rho1": "ϱ", "sigma1": "ς", "theta1": "ϑ", "pi1": "ϖ",
    "equivasymptotic": "≍", "similar": "∼", "proportional": "∝",
    "zerooldstyle": "0", "oneoldstyle": "1", "twooldstyle": "2", "threeoldstyle": "3", "fouroldstyle": "4",
    "fiveoldstyle": "5", "sixoldstyle": "6", "sevenoldstyle": "7", "eightoldstyle": "8", "nineoldstyle": "9",
    # cmex big operators: one sized glyph, not a piece
    "unionsqtext": "⊔", "unionsqdisplay": "⊔", "circleplustext": "⊕", "circleplusdisplay": "⊕",
    "circlemultiplytext": "⊗", "circlemultiplydisplay": "⊗", "logicalandtext": "∧",
    "logicalanddisplay": "∧", "logicalortext": "∨", "logicalordisplay": "∨",
}


def _omx_name(name: str) -> str | None:
    m = _OMX_RE.match(name)
    return _OMX_STEMS.get(m.group(1)) if m else None


def glyph_name_to_unicode(name: str) -> str | None:
    try:
        from fontTools.agl import toUnicode
    except ImportError:  # optional dependency: without it only the TeX name lists apply
        toUnicode = lambda _n: ""  # noqa: E731
    out = toUnicode(name) or _omx_name(name) or _TEX_NAMES.get(name, "")
    if not out or any(0xE000 <= ord(c) <= 0xF8FF for c in out):  # private use = not a real answer
        return None
    return _CANON.get(out, out)


def _builtin_encoding(font_desc) -> dict[int, str]:
    """code -> glyph name from the font program itself (Type1 cleartext or CFF)."""
    try:
        if "/FontFile" in font_desc:
            stream = font_desc["/FontFile"].get_object()
            data = stream.get_data()
            n1 = int(stream.get("/Length1", 0)) or data.find(b"eexec")
            clear = data[: n1 if n1 else len(data)]
            if b"/Encoding StandardEncoding" in clear:
                return {}
            out = {}
            for radix, code, nm in _DUP_RE.findall(clear):
                out[int(code, int(radix) if radix else 10)] = nm.decode("latin1")
            return out
        if "/FontFile3" in font_desc:
            from fontTools.cffLib import CFFFontSet

            data = font_desc["/FontFile3"].get_object().get_data()
            cff = CFFFontSet()
            cff.decompile(io.BytesIO(data), None)
            enc = getattr(cff[cff.fontNames[0]], "Encoding", None)
            if isinstance(enc, list):
                return {i: n for i, n in enumerate(enc) if n and n != ".notdef"}
    except Exception:  # noqa: BLE001 - a broken font program just means "no names"
        return {}
    return {}


@dataclass
class FontTruth:
    """code -> corrected character for one font dictionary."""

    table: dict[int, str] = field(default_factory=dict)


def font_truth(font_dict) -> FontTruth | None:
    base = str(font_dict.get("/BaseFont", "")).lstrip("/")
    tex = family_table(base)
    if tex is None:
        return None
    fd = font_dict.get("/FontDescriptor")
    names: dict[int, str] = {}
    if fd is not None:
        names.update(_builtin_encoding(fd.get_object()))
    diff_codes: set[int] = set()
    enc = font_dict.get("/Encoding")
    if enc is not None:
        enc = enc.get_object()
        diffs = enc.get("/Differences") if hasattr(enc, "get") else None
        if diffs:
            code = 0
            for item in diffs.get_object():
                item = item.get_object() if hasattr(item, "get_object") else item
                if isinstance(item, (int, float)):
                    code = int(item)
                else:
                    names[code] = str(item).lstrip("/")
                    diff_codes.add(code)
                    code += 1
    truth = FontTruth()
    for code in set(names) | set(tex):
        by_name = glyph_name_to_unicode(names[code]) if code in names else None
        # The glyph name describes the glyph that is really drawn, so it wins.
        # The standard-layout table is only for fonts whose names could not be
        # read at all: some files re-encode CM fonts (lower-case "cmmi"/"cmbx"
        # names; measured 2026-10-08: code 0x01 is 'f' there, not Delta), so a
        # code whose name exists but is unknown stays unresolved rather than
        # being guessed from the table.
        pick = by_name or (tex.get(code) if (not names and code not in diff_codes) else None)
        if pick:
            truth.table[code] = pick
    return truth




# ---------------------------------------------------------------------------
# Comparing with what the PDF already says
# ---------------------------------------------------------------------------

# Characters extractors legitimately substitute for each other; an existing
# mapping that differs only inside one of these groups is not "wrong".
_EQUIV_GROUPS = ["-‐‑‒–­−", "‘’'′", "“”\"″",
                 "•∙·⋅", "∘◦", "*∗", "<⟨〈", ">⟩〉"]
_EQUIV = {c: i for i, g in enumerate(_EQUIV_GROUPS) for c in g}


def _same(existing: str, truth: str) -> bool:
    if unicodedata.normalize("NFKC", existing) == unicodedata.normalize("NFKC", truth):
        return True
    return len(existing) == 1 and len(truth) == 1 and existing in _EQUIV and _EQUIV.get(existing) == _EQUIV.get(truth)


_HEX = rb"<([0-9A-Fa-f]+)>"
_BFCHAR = re.compile(rb"beginbfchar(.*?)endbfchar", re.S)
_BFRANGE = re.compile(rb"beginbfrange(.*?)endbfrange", re.S)
_CODESPACE = re.compile(rb"begincodespacerange(.*?)endcodespacerange", re.S)


def _utf16(hexstr: bytes) -> str:
    try:
        return bytes.fromhex(hexstr.decode("ascii")).decode("utf-16-be")
    except (ValueError, UnicodeDecodeError):
        return "\ufffd"


def _plain(text: str) -> bool:
    return all(ord(c) <= 0xFF or 0x2010 <= ord(c) <= 0x201F or ord(c) in range(0xFB00, 0xFB05) for c in text)


def parse_tounicode(data: bytes) -> dict[int, str] | None:
    """code -> text of a ToUnicode CMap, or None when it is not a plain
    one-byte CMap this module can merge into (then the font is left alone)."""
    for block in _CODESPACE.findall(data):
        if any(len(h) != 2 for h in re.findall(_HEX, block)):
            return None
    out: dict[int, str] = {}
    for block in _BFCHAR.findall(data):
        toks = re.findall(_HEX, block)
        for src, dst in zip(toks[0::2], toks[1::2]):
            out[int(src, 16)] = _utf16(dst)
    for block in _BFRANGE.findall(data):
        for lo, hi, rest in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])", block):
            if rest.startswith(b"["):
                dsts = [_utf16(h) for h in re.findall(_HEX, rest)]
            else:
                first = _utf16(rest[1:-1])
                dsts = [first[:-1] + chr(ord(first[-1]) + k) for k in range(int(hi, 16) - int(lo, 16) + 1)] if first else []
            for k, d in enumerate(dsts):
                out[int(lo, 16) + k] = d
    return out


def build_tounicode(mapping: dict[int, str]) -> bytes:
    lines = ["/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
             "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
             "/CMapName /Adobe-Identity-UCS def", "/CMapType 2 def",
             "1 begincodespacerange", "<00> <FF>", "endcodespacerange"]
    items = sorted((c, t) for c, t in mapping.items() if 0 <= c <= 255)
    for i in range(0, len(items), 100):
        chunk = items[i:i + 100]
        lines.append(f"{len(chunk)} beginbfchar")
        lines += [f"<{c:02X}> <{t.encode('utf-16-be').hex().upper()}>" for c, t in chunk]
        lines.append("endbfchar")
    lines += ["endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"]
    return "\n".join(lines).encode("ascii")


def plan_font(font_dict) -> dict[int, str] | None:
    """The complete corrected code -> text map for one font dictionary, or None
    when the font must be left alone (see the module docstring)."""
    truth = font_truth(font_dict)
    if truth is None or not truth.table:
        return None
    named = _names_of(font_dict)
    tu = font_dict.get("/ToUnicode")
    existing: dict[int, str] | None = None
    if tu is not None:
        try:
            existing = parse_tounicode(tu.get_object().get_data())
        except Exception:  # noqa: BLE001 - unreadable CMap: do not touch
            return None
        if existing is None:
            return None
        # Compare only codes the font really has a glyph for: a code with an
        # existing entry (it must agree) or with a glyph name (it must be
        # present). The standard-layout fallback table of a font without names
        # lists codes nobody uses, so they cannot make it "disagree".
        bad = {c: t for c, t in truth.table.items()
               if (c in existing and not _same(existing[c], t)) or (c not in existing and c in named)}
    else:
        # No /ToUnicode: extractors guess from the encoding, which works for
        # plain text (raft.pdf: a CMSY9 with only a section sign reads fine
        # without help). Patch only if some glyph is a symbol beyond Latin-1
        # and general punctuation (Greek, math operators, primes ...). Needs
        # glyph names to know which codes exist at all.
        if not named:
            return None
        existing = {}
        bad = {c: t for c, t in truth.table.items() if c in named}
        if all(_plain(t) for t in bad.values()):
            return None
    if not bad:
        return None
    merged = dict(existing)
    merged.update(bad)
    # Codes whose glyph has a name but no single-character meaning (extensible
    # bracket pieces, hat accents) are left exactly as they were: an existing
    # U+FFFD stays, and an absent entry stays absent so the extractor behaves as
    # before. Writing U+FFFD there turned 0 into up to 129 U+FFFD in 40 of 174
    # patched library PDFs (measured 2026-10-08) with no gain.
    return merged


def _names_of(font_dict) -> set[int]:
    fd = font_dict.get("/FontDescriptor")
    return set(_builtin_encoding(fd.get_object())) if fd is not None else set()


# ---------------------------------------------------------------------------
# The patched copy
# ---------------------------------------------------------------------------


def _cm_font_names(reader) -> bool:
    seen: set[int] = set()
    for page in reader.pages:
        res = page.get("/Resources")
        fonts = res.get_object().get("/Font") if res else None
        for ref in (fonts.get_object().values() if fonts else []):
            key = getattr(ref, "idnum", id(ref))
            if key in seen:
                continue
            seen.add(key)
            if family_table(str(ref.get_object().get("/BaseFont", ""))) is not None:
                return True
    return False


def prepare_pdf(src, work_dir) -> tuple[object, dict]:
    """Return (path to read, stats). The path is `src` itself unless at least
    one CM font needed a corrected /ToUnicode; then it is a patched copy inside
    `work_dir` (the caller removes it). Never raises: any failure means `src`."""
    from pathlib import Path

    stats = {"fonts": 0, "codes": 0}
    try:
        import pypdf
        from pypdf.generic import DecodedStreamObject, NameObject

        reader = pypdf.PdfReader(str(src))
        if reader.is_encrypted or not _cm_font_names(reader):
            return src, stats
        writer = pypdf.PdfWriter(clone_from=reader)
        done: set[int] = set()
        for page in writer.pages:
            res = page.get("/Resources")
            fonts = res.get_object().get("/Font") if res else None
            for ref in (fonts.get_object().values() if fonts else []):
                key = getattr(ref, "idnum", id(ref))
                if key in done:
                    continue
                done.add(key)
                fdict = ref.get_object()
                merged = plan_font(fdict)
                if merged is None:
                    continue
                before = parse_tounicode(fdict["/ToUnicode"].get_object().get_data()) if "/ToUnicode" in fdict else {}
                stream = DecodedStreamObject()
                stream.set_data(build_tounicode(merged))
                fdict[NameObject("/ToUnicode")] = writer._add_object(stream)
                stats["fonts"] += 1
                stats["codes"] += sum(1 for c, t in merged.items() if before.get(c) != t)
        if not stats["fonts"]:
            return src, stats
        dst = Path(work_dir) / "tounicode-fixed.pdf"
        with open(dst, "wb") as fh:
            writer.write(fh)
        return dst, stats
    except Exception as err:  # noqa: BLE001 - the original PDF always remains usable
        import sys

        print(f"pdf_tounicode: {err}", file=sys.stderr)
        return src, {"fonts": 0, "codes": 0}
