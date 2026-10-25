# -*- coding: utf-8 -*-
"""Known OCR confusions inside formulas.

OCR'd math can be valid LaTeX and still wrong: Sigma recognised as `\\S`
(section sign) compiles in KaTeX, so the KaTeX validation path never objects.
This only DETECTS and REPORTS. `\\S_{i=1}^{n}` is almost certainly `\\sum`,
but the text is NOT rewritten (accuracy rule: never silently fix).

Flagged inside $$..$$, $..$, \\[..\\] and \\(..\\): `\\S`, `\\P`, `\\copyright`,
`\\pounds`, `\\dag`, `\\ddag` (exact command names; `\\Sigma`, `\\Pr`, `\\dagger`
are not matched). Page numbers are looked up by locating the 8 non-space
characters of prose before the formula in the pypdf page texts (best effort;
omitted when not uniquely found).
"""
from __future__ import annotations

import re

import glyph_check

_FORMULA = re.compile(
    r"\$\$(?P<d>.*?)\$\$|\\\[(?P<b>.*?)\\\]|\\\((?P<p>.*?)\\\)|(?<![\\$])\$(?P<i>[^$\n]+?)\$",
    re.DOTALL,
)
_SUSPECT = re.compile(r"\\(S|P|copyright|pounds|ddag|dag)(?![A-Za-z])")
_LIMITS = re.compile(r"\\(?:S|P)\s*[_^]")
_MEANING = {
    "S": ("§", "\\sum"),
    "P": ("¶", "\\prod veya \\partial"),
    "copyright": ("©", "c/C"),
    "pounds": ("£", "E veya f"),
    "dag": ("†", "+ veya t"),
    "ddag": ("‡", "+ veya t"),
}


def scan(text: str) -> list[dict]:
    hits = []
    for m in _FORMULA.finditer(text):
        body = m.group("d") or m.group("b") or m.group("p") or m.group("i") or ""
        found = _SUSPECT.findall(body)
        if not found:
            continue
        before = glyph_check._STRIP_MD.sub("", text[max(0, m.start() - 200):m.start()])
        hits.append({
            "cmds": found,
            "limits": bool(_LIMITS.search(body)),
            "context": before[-glyph_check.PREFIX_LEN:],
        })
    return hits


def locate_pages(hits: list[dict], page_texts: list[str]) -> None:
    norm = [glyph_check._norm_page(t) for t in page_texts]
    for h in hits:
        ctx = h["context"]
        found = (
            [i + 1 for i, n in enumerate(norm) if ctx in n]
            if len(ctx) == glyph_check.PREFIX_LEN
            else []
        )
        h["page"] = found[0] if len(found) == 1 else None


def warnings(hits: list[dict]) -> list[str]:
    out = []
    by_cmd: dict[str, list] = {}
    for h in hits:
        for c in set(h["cmds"]):
            by_cmd.setdefault(c, []).append(h)
    for cmd, hs in sorted(by_cmd.items()):
        sym, likely = _MEANING[cmd]
        pages = sorted({h["page"] for h in hs if h.get("page")})
        strong = sum(1 for h in hs if h["limits"] and cmd in ("S", "P"))
        msg = f"OCR şüphesi: {len(hs)} formülde '\\{cmd}' ({sym}) var, büyük olasılıkla '{likely}'"
        if strong:
            msg += f" ({strong} tanesinde alt/üst sınırla birlikte: toplam/çarpım işareti gibi)"
        if pages:
            msg += f"; s. {glyph_check._page_list(pages)}"
        out.append(msg + ". Kaynakla karşılaştırın; metin otomatik düzeltilmedi.")
    return out


def check(final_text: str, pdf_path=None) -> list[str]:
    """Warnings; the pypdf read happens only when a suspect formula exists."""
    try:
        hits = scan(final_text)
        if not hits:
            return []
        if pdf_path is not None:
            locate_pages(hits, glyph_check.read_pypdf_pages(pdf_path))
        return warnings(hits)
    except Exception:  # noqa: BLE001
        return []
