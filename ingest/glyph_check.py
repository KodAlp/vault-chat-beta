# -*- coding: utf-8 -*-
"""Silent glyph corruption detector (TODO #6).

Seen on a Linear Algebra lecture PDF: docling emitted "↪" for ",", "▷" for ".",
"♣" for "|" and "ÒÓ" for curly quotes (~107 glyphs) while pypdf's text layer of
the same pages was clean. No U+FFFD is involved, so the FFFD warning never
fires. This module only DETECTS and REPORTS; it never edits text.

Rule: a character is "suspect" when
  - it is a rare symbol: an arrow / geometric shape / dingbat block char, a
    modifier symbol (Sk), or one of the Latin-1 letters Ò Ó Ô Õ Ð Þ Ñ Ã
    (none are Turkish), and
  - docling emitted it >= MIN_CHAR_COUNT times, and
  - the pypdf text layer has it far less often (docling count > 3 * pypdf + 2).
Each docling occurrence is then LOCATED: the 8 ASCII letters/digits before it
(fallback 5, <= 3 pages) are searched in the ASCII letters/digits of each pypdf page; only occurrences that
land on exactly one page with substantive pypdf text count as evidence
(scanned/OCR pages have no pypdf text, so OCR noise cannot trigger this). The
warning fires when >= MIN_LOCATED located occurrences exist. The character that
follows the same prefix in pypdf is a vote for a 1:1 substitution; a mapping is
only offered (as text in the warning, never applied) with >= 3 votes and >= 80%
agreement. Work is capped: MAX_PAGES pages read, MAX_OCCURRENCES located.
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

MAX_PAGES = 400
MAX_OCCURRENCES = 300
MIN_CHAR_COUNT = 3
MIN_LOCATED = 3
MIN_PAGE_CHARS = 40
MAX_HIT_PAGES = 8
SHORT_PREFIX_LEN = 5  # fallback: pypdf renders some math glyphs as letters (∥ -> 'k')
SHORT_MAX_HIT_PAGES = 3
PREFIX_LEN = 8
MIN_VOTES = 3
MIN_AGREEMENT = 0.8

_ODD_LATIN1 = "ÒÓÔÕÐÞÑÃ"  # not × or Ø: legitimate math / Scandinavian
_SYMBOL_BLOCKS = (
    (0x2190, 0x21FF),  # arrows
    (0x25A0, 0x25FF),  # geometric shapes (triangles)
    (0x2600, 0x27BF),  # misc symbols, dingbats (card suits)
    (0x2B00, 0x2BFF),
)
_STRIP_MD = re.compile(r"[\s*_`$#>|\\]")
_WS = re.compile(r"\s+")


def is_suspect_char(ch: str) -> bool:
    """Rare symbol / unusual Latin-1 letter that real lecture text seldom has."""
    cp = ord(ch)
    if cp < 0x80 or ch.isspace():
        return False
    if any(lo <= cp <= hi for lo, hi in _SYMBOL_BLOCKS):
        return True
    if ch in _ODD_LATIN1:
        return True
    return unicodedata.category(ch) == "Sk"


def _norm_page(text: str) -> str:
    return _WS.sub("", text)


def _is_key(c: str) -> bool:
    """ASCII letters/digits only: math glyphs, Greek letters and accents differ
    between pypdf and docling for the same text, ASCII ones do not."""
    return c.isascii() and c.isalnum()


def _alnum_index(norm: str) -> tuple[str, list[int]]:
    """Lowercase ASCII letters/digits of `norm` and each one's index in `norm`,
    so a prefix match survives punctuation and symbol differences."""
    chars, idx = [], []
    for i, c in enumerate(norm):
        if _is_key(c):
            chars.append(c.lower())
            idx.append(i)
    return "".join(chars), idx


def read_pypdf_pages(path: Path, max_pages: int = MAX_PAGES) -> list[str]:
    """Raw pypdf text per page (index 0 = page 1). [] on any failure."""
    try:
        from pypdf import PdfReader

        pages = PdfReader(str(path)).pages
        return [(p.extract_text() or "") for p in list(pages)[:max_pages]]
    except Exception:  # noqa: BLE001 - optional check
        return []


def _page_list(pages: list[int], limit: int = 10) -> str:
    shown = ", ".join(str(n) for n in pages[:limit])
    return shown + ", …" if len(pages) > limit else shown


def detect(docling_text: str, page_texts: list[str]) -> dict | None:
    """None when clean. Otherwise {"chars": {ch: {...}}, "located": int}.
    `map` is the learned substitute ("," for "↪") or None."""
    norm_pages = [_norm_page(t) for t in page_texts]
    substantive = [len(n) >= MIN_PAGE_CHARS for n in norm_pages]
    if not any(substantive):
        return None
    pypdf_all = "".join(page_texts)
    doc_counts = Counter(c for c in docling_text if is_suspect_char(c))
    candidates = {
        c for c, n in doc_counts.items()
        if n >= MIN_CHAR_COUNT and n > 3 * pypdf_all.count(c) + 2
    }
    if not candidates:
        return None
    indexed = [_alnum_index(n) for n in norm_pages]
    # identical pages (repeated slides) count once towards "boilerplate" limits
    first_of: dict[str, int] = {}
    group = [first_of.setdefault(n, pi) for pi, n in enumerate(norm_pages)]
    stripped = _STRIP_MD.sub("", docling_text)
    page_votes: dict[str, list] = defaultdict(list)
    votes: dict[str, Counter] = defaultdict(Counter)
    located: Counter = Counter()
    seen = 0
    keys = [i for i, c in enumerate(stripped) if _is_key(c)]
    import bisect

    for i, ch in enumerate(stripped):
        if ch not in candidates:
            continue
        seen += 1
        if seen > MAX_OCCURRENCES:
            break
        k = bisect.bisect_left(keys, i)  # keys[:k] precede the suspect char
        hits: list = []  # (page index, match start, match end) in the page's key string
        for plen, max_pages, fuzzy in (
            (PREFIX_LEN, MAX_HIT_PAGES, False),
            (PREFIX_LEN, MAX_HIT_PAGES, True),
            (SHORT_PREFIX_LEN, SHORT_MAX_HIT_PAGES, False),
        ):
            if k < plen:
                continue
            prefix = "".join(stripped[j].lower() for j in keys[k - plen:k])
            if fuzzy:
                # pypdf renders some math glyphs as stray letters (norm bars as
                # 'k'): tolerate one extra pypdf key char between prefix chars.
                rx = re.compile(".?".join(re.escape(c) for c in prefix), re.DOTALL)
                hits = []
                for pi, (a, _ix) in enumerate(indexed):
                    if not substantive[pi]:
                        continue
                    m = rx.search(a)
                    if m:
                        hits.append((pi, m.start(), m.end()))
            else:
                hits = [
                    (pi, a.find(prefix), a.find(prefix) + len(prefix))
                    for pi, (a, _ix) in enumerate(indexed)
                    if substantive[pi] and prefix in a
                ]
            if hits and len({group[h[0]] for h in hits}) <= max_pages:
                break
            hits = []
        if not hits:  # none found, or only boilerplate prefixes
            continue
        # docling's gap: everything between the prefix's last key char and the
        # next key char, with the suspect char at `back` places from its end
        nxt_key = keys[k] if k < len(keys) else len(stripped)
        gap_docling = stripped[keys[k - 1] + 1:nxt_key]
        back = nxt_key - 1 - i
        located[ch] += 1
        for pi, _start, end in hits:
            vote = None
            ix = indexed[pi][1]
            gap_pypdf = norm_pages[pi][ix[end - 1] + 1:(ix[end] if end < len(ix) else len(norm_pages[pi]))]
            if len(gap_pypdf) > back and len(gap_pypdf) <= len(gap_docling) + 2:
                vote = gap_pypdf[len(gap_pypdf) - 1 - back]
                votes[ch][vote] += 1
            if len({group[h[0]] for h in hits}) <= SHORT_MAX_HIT_PAGES:
                page_votes[ch].append((pi + 1, vote))
    result: dict[str, dict] = {}
    for ch in candidates:
        if located[ch] == 0:
            continue
        mapping = None
        total = sum(votes[ch].values())
        if total >= MIN_VOTES:
            sub, n = votes[ch].most_common(1)[0]
            if n / total >= MIN_AGREEMENT and sub != ch:
                mapping = sub
        result[ch] = {
            "count": doc_counts[ch],
            "located": located[ch],
            # with a learned map, only pages whose aligned char agrees with it
            "pages": sorted({p for p, v in page_votes[ch] if mapping is None or v == mapping}),
            "map": mapping,
        }
    total_located = sum(v["located"] for v in result.values())
    if total_located < MIN_LOCATED:
        return None
    return {"chars": result, "located": total_located}


def warning(report: dict | None) -> str | None:
    if not report:
        return None
    chars = report["chars"]
    all_pages = sorted({p for v in chars.values() for p in v["pages"]})
    parts = []
    for ch, v in sorted(chars.items(), key=lambda kv: -kv[1]["count"])[:5]:
        if v["map"]:
            parts.append(f"'{ch}' ({v['count']}×; pypdf'de '{v['map']}' olabilir)")
        else:
            parts.append(f"'{ch}' ({v['count']}×)")
    return (
        "Sessiz glif bozulması şüphesi: docling PDF'te olmayan simgeler üretmiş olabilir: "
        + ", ".join(parts)
        + f" (s. {_page_list(all_pages)}); pypdf metni bu sayfalarda temiz. "
        "Bu yerleri kaynakla karşılaştırın; metin otomatik düzeltilmedi."
    )


def check(docling_text: str, pdf_path: Path) -> str | None:
    """Warning text or None. Never raises."""
    try:
        if not any(is_suspect_char(c) for c in docling_text):
            return None  # cheap exit: no pypdf read at all
        return warning(detect(docling_text, read_pypdf_pages(pdf_path)))
    except Exception:  # noqa: BLE001
        return None
