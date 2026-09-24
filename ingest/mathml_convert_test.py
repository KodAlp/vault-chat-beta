# -*- coding: utf-8 -*-
"""Tests for mathml_convert.py.

    python ingest/mathml_convert_test.py

Not part of `npm test` — same convention as postprocess_test.py/
extract_web_test.py. Cases mirror what was actually measured on
2026-09-24: a live Wikipedia page (209/209 formulas silently dropped by
trafilatura before this module, 209/209 recovered after), and py-asciimath
crashing outright on Windows via its public .translate() API (DTD
SYSTEM-path resolution failure) until called through the parser+transformer
directly with dtd_validation=False.
"""
import sys
from pathlib import Path

import trafilatura

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mathml_convert import (  # noqa: E402
    MATH_CONVERSION_FAILED,
    alttext_to_latex,
    annotation_to_latex,
    mathml_element_to_latex,
    replace_math_with_placeholders,
)

failures: list[str] = []


def check(name: str, ok: bool) -> None:
    print(("PASS  " if ok else "FAIL  ") + name)
    if not ok:
        failures.append(name)


def test_alttext_to_latex() -> None:
    check(
        "displaystyle wrapper stripped",
        alttext_to_latex("{\\displaystyle ax^{2}+bx+c=0}") == "ax^{2}+bx+c=0",
    )
    check(
        "unwrapped alttext passed through as-is",
        alttext_to_latex("x^2") == "x^2",
    )
    check("empty alttext is None", alttext_to_latex("") is None)
    check("missing alttext is None", alttext_to_latex(None) is None)


def _mathml_node(inner: str, **attrs: str):
    import lxml.html

    attr_str = " ".join(f'{k}="{v}"' for k, v in attrs.items())
    html = f'<html><body><math xmlns="http://www.w3.org/1998/Math/MathML" {attr_str}>{inner}</math></body></html>'
    tree = lxml.html.fromstring(html)
    return tree.xpath("//math")[0]


def test_annotation_to_latex() -> None:
    node = _mathml_node(
        '<semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics>'
    )
    check("TeX annotation extracted", annotation_to_latex(node) == "x^2")

    no_annotation = _mathml_node("<mi>x</mi>")
    check("no annotation present: None, not an exception", annotation_to_latex(no_annotation) is None)

    wrong_encoding = _mathml_node(
        '<semantics><mi>x</mi><annotation encoding="MathML-Presentation">ignored</annotation></semantics>'
    )
    check("non-TeX annotation encoding is ignored", annotation_to_latex(wrong_encoding) is None)


def test_mathml_element_to_latex_via_py_asciimath() -> None:
    # This is the case that crashed outright on Windows before the
    # dtd_validation=False bypass: py-asciimath's public .translate() API
    # hardcodes dtd_validation=True and builds a DOCTYPE from a raw Windows
    # backslash path that libxml2 cannot resolve as a URI.
    fraction = _mathml_node("<mfrac><mi>a</mi><mi>b</mi></mfrac>")
    latex = mathml_element_to_latex(fraction)
    check("py-asciimath converts a fraction", latex is not None and "\\frac{a}{b}" in latex)

    power_and_root = _mathml_node(
        "<msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><msqrt><mi>y</mi></msqrt>"
    )
    latex2 = mathml_element_to_latex(power_and_root)
    check(
        "py-asciimath converts a power and a square root",
        latex2 is not None and "^{2}" in latex2 and "\\sqrt{y}" in latex2,
    )

    sum_with_bounds = _mathml_node(
        '<munderover><mo>&#x2211;</mo><mrow><mi>i</mi><mo>=</mo><mn>0</mn></mrow><mi>n</mi></munderover><msub><mi>a</mi><mi>i</mi></msub>'
    )
    latex3 = mathml_element_to_latex(sum_with_bounds)
    check(
        "py-asciimath converts a bounded sum with a subscript",
        latex3 is not None and "\\sum" in latex3 and "_{i=0}" in latex3 and "^{n}" in latex3,
    )


def test_replace_math_with_placeholders_inline_and_display() -> None:
    html = (
        "<html><body><article>"
        '<p>Inline: <math xmlns="http://www.w3.org/1998/Math/MathML" alttext="x^2"><mi>x</mi></math> done.</p>'
        '<p>Display: <math xmlns="http://www.w3.org/1998/Math/MathML" display="block" alttext="y=mx+b"><mi>y</mi></math></p>'
        "</article></body></html>"
    )
    new_html, total, failed = replace_math_with_placeholders(html)
    check("both math nodes counted", total == 2)
    check("both resolved via alttext, none failed", failed == 0)
    check("inline math becomes single-dollar", "$x^2$" in new_html)
    check("display math becomes double-dollar", "$$y=mx+b$$" in new_html)


def test_replace_math_with_placeholders_unresolvable_node() -> None:
    # No alttext, no annotation, and structurally too exotic for
    # py-asciimath's transformer (an unsupported element) -- must fail
    # closed to a visible placeholder, never silently vanish.
    html = (
        "<html><body><article>"
        '<p>Broken: <math xmlns="http://www.w3.org/1998/Math/MathML"><munknown/></math> end.</p>'
        "</article></body></html>"
    )
    new_html, total, failed = replace_math_with_placeholders(html)
    check("one math node counted", total == 1)
    check("conversion recorded as failed", failed == 1)
    check("failed node gets the visible placeholder, not silence", MATH_CONVERSION_FAILED in new_html)


def test_hidden_a11y_wrapper_is_replaced_not_orphaned() -> None:
    # Reproduces the actual MediaWiki Math extension shape measured on
    # Wikipedia: a visible <img> next to a screen-reader-only <math>
    # wrapped in display:none. Splicing text in at <math>'s own position
    # (the naive approach) lands it inside the hidden span, which
    # trafilatura's boilerplate removal then discards -- this must not
    # happen; the whole hidden wrapper must be replaced instead.
    html = (
        "<html><body><article>"
        '<p>The formula '
        '<span class="mwe-math-element">'
        '<span class="mwe-math-mathml-a11y" style="display: none;">'
        '<math xmlns="http://www.w3.org/1998/Math/MathML" alttext="x^2+1"><mi>x</mi></math>'
        "</span>"
        '<img src="x.svg" alt="x^2+1">'
        "</span>"
        " holds.</p>"
        "<p>Padding paragraph so trafilatura keeps this article body instead of discarding it as too thin,"
        " since very short pages are sometimes rejected outright by its readability-style boilerplate removal.</p>"
        "</article></body></html>"
    )
    new_html, total, failed = replace_math_with_placeholders(html)
    check("hidden wrapper's math counted", total == 1)
    check("resolved via alttext", failed == 0)
    check("hidden span itself is gone from the output", "display: none" not in new_html)
    check("placeholder text is present outside any hidden wrapper", "$x^2+1$" in new_html)

    extracted = trafilatura.extract(new_html, output_format="markdown", with_metadata=True)
    check(
        "the placeholder actually survives trafilatura's boilerplate removal (the real bug this fixes)",
        extracted is not None and "$x^2+1$" in extracted,
    )


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    test_alttext_to_latex()
    test_annotation_to_latex()
    test_mathml_element_to_latex_via_py_asciimath()
    test_replace_math_with_placeholders_inline_and_display()
    test_replace_math_with_placeholders_unresolvable_node()
    test_hidden_a11y_wrapper_is_replaced_not_orphaned()
    print(f"\n{len(failures)} başarısız" if failures else "\nhepsi geçti")
    sys.exit(1 if failures else 0)
