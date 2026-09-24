"""MathML -> LaTeX pre-processing for extract_web.py (Aşama 10, #2).

Measured (2026-09-24), not assumed: trafilatura.extract() silently drops
every <math>...</math> element -- no error, no warning, the formula just
isn't in the output. Confirmed against a live Wikipedia page (209/209
formulas vanished). This module replaces each <math> element with an
inline ($...$) or display ($$...$$) LaTeX placeholder BEFORE the HTML is
handed to trafilatura, so trafilatura sees ordinary text and keeps it.
postprocess.py's own HTML-tag stripper already treats $.../$$ ... $$ as
verbatim (Aşama 2, Ö1), so nothing downstream re-mangles the substitution.

Three extraction strategies, tried in order, measured against a live
Wikipedia page (en.wikipedia.org/wiki/Quadratic_formula, 209 formulas):

1. `alttext` attribute -- the MediaWiki Math extension (Wikipedia and any
   MediaWiki wiki using it) always carries the original TeX source here.
   Covered all 209/209 on the measured page.
2. `<annotation encoding="application/x-tex">` -- the MathML spec's own
   source-embedding convention; also written by MathJax's MathML output
   mode. Not exercised by the Wikipedia case (alttext already covered it)
   but cheap to check and strictly more reliable than converting markup.
3. py-asciimath's MathMLParser/MathML2Tex -- an actual MathML structural
   converter, used only when neither of the above is present (hand-written
   MathML with no TeX source attached). Verified correct on fractions,
   powers, roots, sums with bounds, subscripts and simple matrices
   (rendered as \\begin{array}, not \\begin{pmatrix} -- valid LaTeX math,
   just no matrix brackets).

Sites that render math with MathJax client-side instead of pre-rendering
to MathML (the more common case on the open web outside Wikipedia --
ProofWiki and most blogs and textbook sites, measured) never reach this
module at all: their raw HTML already contains the original \\(...\\) /
$$...$$ TeX source as plain visible text, which trafilatura already
extracts correctly today, unchanged by this module.

MIT OCW's own HTML pages (checked directly, three real course pages) carry
no math markup at all -- their math-heavy content lives in linked PDFs,
which is what Aşama 10 #1 (PDF link listing) is for, not this module.
"""
import re

import lxml.html

MATH_CONVERSION_FAILED = "[[MATEMATİK ÇEVRİLEMEDİ]]"

_DISPLAYSTYLE_WRAPPER = re.compile(r"^\{\\displaystyle\s+(.*)\}$", re.DOTALL)
_HIDDEN_STYLE = re.compile(r"display\s*:\s*none", re.IGNORECASE)


def alttext_to_latex(alttext: str | None) -> str | None:
    """MediaWiki's alttext is usually wrapped in `{\\displaystyle ...}`;
    stripped here purely for readability -- \\displaystyle is itself valid
    LaTeX, so a wrapper that doesn't match this exact shape (rare) is kept
    as-is rather than dropped."""
    if not alttext or not alttext.strip():
        return None
    s = alttext.strip()
    m = _DISPLAYSTYLE_WRAPPER.match(s)
    return m.group(1).strip() if m else s


def annotation_to_latex(node) -> str | None:
    for ann in node.xpath(".//annotation"):
        if ann.get("encoding") == "application/x-tex" and ann.text and ann.text.strip():
            return ann.text.strip()
    return None


def mathml_element_to_latex(node) -> str | None:
    """Last-resort conversion via py-asciimath, for MathML with no attached
    TeX source. Imported lazily so a missing/broken install only breaks
    this one fallback path, not alttext/annotation extraction (the common
    case, and the only one exercised by the Wikipedia measurement)."""
    try:
        from py_asciimath.parser.parser import MathMLParser
        from py_asciimath.translator.translator import MathML2Tex
    except ImportError:
        return None
    # py_asciimath.parser's own module-level import calls
    # logging.basicConfig(level=logging.DEBUG), which -- because it's the
    # FIRST basicConfig call in the process -- sets the root logger's level
    # for every other library, flooding stderr with unrelated DEBUG noise
    # (trafilatura included) and burying real errors when convertQueue's
    # caller shows the tail of stderr after a crash. Reset it back down
    # every call; idempotent and cheap.
    import logging

    logging.getLogger().setLevel(logging.WARNING)
    xml = lxml.html.tostring(node, encoding="unicode")
    if "xmlns=" not in xml:
        xml = xml.replace("<math", '<math xmlns="http://www.w3.org/1998/Math/MathML"', 1)
    try:
        # NOT MathML2Tex().translate() -- that hardcodes dtd_validation=True,
        # which fails outright on Windows: py-asciimath builds a DOCTYPE
        # SYSTEM identifier from a raw Windows backslash path
        # ("C:\\...\\dtd\\mathml3\\mathml3.dtd"), which libxml2 cannot
        # resolve as a URI (fails with "failed to load external entity
        # 'NULL'") -- reproduced on a trivial <mfrac>, before ever reaching
        # a real page. DTD validation is schema-conformance checking, not
        # needed to produce correct LaTeX, so this calls the parser
        # directly with dtd_validation=False and goes straight to the
        # transformer .translate() would have called next.
        parsed = MathMLParser.parse(xml, dtd_validation=False, network=False, resolve_entities=True)
        latex = str(MathML2Tex().transformer(parsed)).strip()
        return latex or None
    except Exception:  # noqa: BLE001 — a converter's own parse failure becomes a placeholder, not a crash
        return None


def mathml_node_to_latex(node) -> str | None:
    return alttext_to_latex(node.get("alttext")) or annotation_to_latex(node) or mathml_element_to_latex(node)


def _hidden_replacement_target(node):
    """Wikipedia (and the MediaWiki Math extension generally) renders each
    formula as an <img> for sighted users plus a sibling, accessibility-only
    <math> wrapped in a display:none span for screen readers. Splicing the
    LaTeX placeholder in at the exact <math> position lands it inside that
    hidden span -- which trafilatura's boilerplate removal then (correctly)
    discards as invisible, so the substitution silently vanished anyway
    (measured: 0 of 209 formulas survived before this walk-up was added).
    Walking up to the outermost display:none ancestor and replacing THAT
    whole node instead removes the hidden wrapper (and the redundant <img>
    beside it) and leaves plain visible text in its place."""
    target = node
    parent = target.getparent()
    while parent is not None:
        if _HIDDEN_STYLE.search(target.get("style") or ""):
            return target
        target = parent
        parent = target.getparent()
    return node


def replace_math_with_placeholders(html: str) -> tuple[str, int, int]:
    """Returns (new_html, total_math_nodes, failed_count). failed_count is
    how many nodes fell through all three strategies and got the literal
    MATH_CONVERSION_FAILED placeholder instead of real LaTeX -- the caller
    uses this to set needs_review and add a warning."""
    tree = lxml.html.fromstring(html)
    total = 0
    failed = 0
    # Two math nodes can (rarely) share one display:none ancestor -- if the
    # naive per-node remove-and-splice ran node by node, the second
    # replacement would land on an already-detached target and be silently
    # lost. Grouping by target id first and concatenating text keeps every
    # formula's text even in that shared-wrapper case.
    by_target: dict[int, tuple[object, list[str]]] = {}
    target_order: list[int] = []
    for node in tree.xpath("//math"):
        total += 1
        latex = mathml_node_to_latex(node)
        if latex is None:
            latex = MATH_CONVERSION_FAILED
            failed += 1
        display = node.get("display") == "block"
        text = f"$${latex}$$" if display else f"${latex}$"

        target = _hidden_replacement_target(node)
        key = id(target)
        if key not in by_target:
            by_target[key] = (target, [])
            target_order.append(key)
        by_target[key][1].append(text)

    for key in target_order:
        target, texts = by_target[key]
        parent = target.getparent()
        if parent is None:
            continue
        combined = "".join(texts)
        idx = list(parent).index(target)
        if idx == 0:
            parent.text = (parent.text or "") + combined + (target.tail or "")
        else:
            prev = parent[idx - 1]
            prev.tail = (prev.tail or "") + combined + (target.tail or "")
        parent.remove(target)

    return lxml.html.tostring(tree, encoding="unicode"), total, failed
