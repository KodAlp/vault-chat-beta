# -*- coding: utf-8 -*-
"""Tests for postprocess.py's math handling and quality warnings.

    python ingest/postprocess_test.py

Not part of `npm test`, which runs tsx over the TypeScript suites. Run it after
touching postprocess.py — every check here exists because of a real failure:

- wrap_bare_math_environments: a bare \\begin{align} is not atomic to
  indexer/chunk.ts, so a derivation written that way gets split across two
  chunks and each half renders as a KaTeX error.
- quality_warnings: convert.py used to emit `warnings: []` unconditionally. A
  1.2 MB control-theory textbook converted to 22k lines with zero headings,
  zero equations and 5507 (cid:NN) artifacts, and reported no warnings at all.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from postprocess import (  # noqa: E402
    decode_html_entities,
    DEGENERATE_NOTE,
    DEGENERATE_RUN,
    derive_title,
    find_degenerate_run,
    truncate_degenerate_math,
    postprocess,
    quality_warnings,
    strip_html_remnants,
    wrap_alignment_math,
    wrap_bare_math_environments,
)

FIXTURE = r"""# Doc

A bare environment:

\begin{align}
x &= 1 \\
y &= 2
\end{align}

Already wrapped, must not be touched:

$$
\begin{align}
a &= b
\end{align}
$$

Inside a fence, must not be touched:

```latex
\begin{equation}
E = mc^2
\end{equation}
```
"""

failures: list[str] = []


def check(name: str, ok: bool) -> None:
    print(("PASS  " if ok else "FAIL  ") + name)
    if not ok:
        failures.append(name)


def test_wrapping() -> None:
    out = wrap_bare_math_environments(FIXTURE)

    # Two $$ pairs: the one this function added, and the one already there.
    check("bare environment wrapped", out.count("$$") == 4)
    check(
        "pre-existing $$ block untouched",
        out.count("$$\n" + r"\begin{align}" + "\na &= b") == 1,
    )
    check("fenced code untouched", "```latex\n" + r"\begin{equation}" in out)
    check("no empty $$ pair produced", "$$\n$$" not in out)
    check("backslash count unchanged", out.count("\\") == FIXTURE.count("\\"))
    check("LaTeX line break preserved", r"x &= 1 \\" in out)
    # A second conversion pass over an already-converted file must be a no-op,
    # or re-importing a source churns the file and forces a full re-embed.
    check("idempotent", wrap_bare_math_environments(out) == out)


def test_warnings() -> None:
    check(
        "broken font mapping detected",
        any("cid" in w for w in quality_warnings("(cid:12) " * 60, is_pdf=True)),
    )
    check(
        "clean document is silent",
        quality_warnings("# Ok\n\n## Bir\n\npara\n\n## Iki\n\npara\n", is_pdf=True) == [],
    )
    check(
        "oversize atomic block detected",
        any("2048" in w for w in quality_warnings("# Ok\n\n$$ " + "x" * 3000 + " $$\n", is_pdf=True)),
    )
    # Real headings from docling's Trentelman output: 98 of 194 looked like this.
    glued = (
        "# T\n\n## 1.3 Linearcontrolsystems\n\npara\n\n"
        "## 1.5 Linearcontrollers\n\npara\n\n"
        "## 1.6 Example: stabilizingthegeostationaryorbit\n\npara\n\n"
        "## 2.1 Linearspacesandsubspaces\n\npara\n"
    )
    check("glued headings detected", any("bitişik" in w for w in quality_warnings(glued, is_pdf=True)))
    clean_headings = (
        "# T\n\n## Control theory for linear systems\n\npara\n\n"
        "## Mathematical preliminaries\n\npara\n"
    )
    check(
        "well-spaced headings are silent",
        not any("bitişik" in w for w in quality_warnings(clean_headings, is_pdf=True)),
    )

    long_headingless = "# Only an H1\n\n" + "\n\n".join(["paragraf"] * 300)
    check(
        "headingless long PDF detected",
        any("##" in w for w in quality_warnings(long_headingless, is_pdf=True)),
    )
    check(
        "headingless long non-PDF is silent about headings",
        not any("##" in w for w in quality_warnings(long_headingless, is_pdf=False)),
    )


def test_alignment_wrapping() -> None:
    # Verbatim from docling's output for page 38 of Trentelman: `&` markers,
    # no environment. KaTeX rejects this with "Expected 'EOF', got '&'".
    real = (
        r"$$\mathbb { C } ^ { 0 } & \colon = \{ \lambda \} \\ "
        r"\mathbb { C } ^ { + } & \colon = \{ \lambda \}$$"
    )
    out = wrap_alignment_math(real)
    check("alignment block wrapped in aligned", r"\begin{aligned}" in out and r"\end{aligned}" in out)
    check("alignment markers kept", out.count("&") == 2)

    # Page 42: the block ends with a dangling row separator, which would open
    # an empty final row inside aligned.
    trailing = r"$$& = \sum _ { i } A _ { 2 } ^ { i } B _ { 2 } u _ { i } . \\$$"
    out2 = wrap_alignment_math(trailing)
    check("trailing row separator dropped", r"\\\end{aligned}" not in out2)

    untouched = r"$$\begin{pmatrix} a & b \\ c & d \end{pmatrix}$$"
    check("existing environment untouched", wrap_alignment_math(untouched) == untouched)

    plain = r"$$\chi _ { A } ( A ) = 0 .$$"
    check("block without & untouched", wrap_alignment_math(plain) == plain)
    check("idempotent", wrap_alignment_math(out) == out)


def test_entities() -> None:
    check(
        "entity decoded in prose",
        decode_html_entities("the condition is |λ| &lt; 1 for all") == "the condition is |λ| < 1 for all",
    )
    # Tag stripping runs first, so by the time entities are decoded there is no
    # tag stripper left to mistake the result for markup.
    text, _ = postprocess(
        "# T\n\nx &lt; y and <b>bold</b>\n", title_fallback="fb", converted_by="docling", needs_review=False
    )
    check("tags stripped and entities decoded", "x < y and bold" in text)


def test_html_stripping() -> None:
    # Table from the 2026-09-23 report (Ö5): `_HTML_TAG` used to treat any
    # `<word ...>` as markup, so it ate C++ generics, headers and inequalities
    # wherever they appeared — inside code, inside math, or in plain prose.
    # Measured on real content: craftinginterpreters' scanning.html turned
    # `List<Token>` into `List` and `Map<String, TokenType>` into `Map`.
    unchanged = [
        ("`#include <stdio.h>`", "inline code, single angle-bracket header"),
        ("```\n#include <stdio.h>\n```", "fenced code, angle-bracket header"),
        ("`std::vector<int>`", "inline code, template instantiation"),
        ("`List<Token>`", "inline code, Java generic (real craftinginterpreters case)"),
        ("template <typename T>", "plain prose: 'typename' is not an HTML tag name"),
        ("$a<b$ ve $c>d$", "two separate inline-math spans on one line"),
        ("$x < y$", "spaced inequality inside inline math"),
    ]
    for text, label in unchanged:
        check(f"untouched: {label}", strip_html_remnants(text) == text)

    check(
        "real HTML tag still stripped in prose",
        strip_html_remnants('prose with <div class="x">hi</div> remnant') == "prose with hi remnant",
    )
    check("real void tag still stripped", strip_html_remnants("a <br> break") == "a  break")
    check(
        "code survives even next to a real tag on the same line",
        strip_html_remnants("<b>bold</b> then `List<Token>` in code")
        == "bold then `List<Token>` in code",
    )


def test_derive_title() -> None:
    # K3-7: craftinginterpreters' scanning.html converted with a self-
    # referencing anchor wrapped around its H1 — the title used to come out
    # as the literal "[Scanning4](#top)", brackets and anchor target intact.
    check(
        "a self-linking H1's markup is stripped, not kept verbatim",
        derive_title("# [Scanning4](#top)\n\nbody", "fb") == "Scanning4",
    )
    check(
        "a link mid-title is unwrapped in place",
        derive_title("# See [the appendix](#a1) for details", "fb") == "See the appendix for details",
    )
    check("a plain H1 is untouched", derive_title("# Plain Title\n\nbody", "fb") == "Plain Title")
    check("no H1 falls back", derive_title("no heading here", "fb") == "fb")


def test_signature() -> None:
    # extract_web.py and youtube_transcript.py call postprocess() with this
    # exact shape; adding warnings must not have changed it.
    text, frontmatter = postprocess(
        FIXTURE, title_fallback="fb", converted_by="marker", needs_review=False
    )
    check("postprocess still returns (text, frontmatter)", isinstance(text, str) and isinstance(frontmatter, dict))
    check("title derived from H1", frontmatter["title"] == "Doc")
    check("needs_review omitted when false", "needs_review" not in frontmatter)


def test_degenerate_math():
    print("degenerate formula loops")
    loop = "\\begin{array}{l} \\text {for (i = 1;i <   100;i = i + 1) \\{} \\\\ " + "\\quad " * 3900
    check("loop detected", find_degenerate_run(loop) > 0)
    check("short repetition is fine", find_degenerate_run("a + b + " * (DEGENERATE_RUN // 4) + "c") == -1)
    check("legit matrix is fine", find_degenerate_run("\\begin{pmatrix} " + "1 & 0 \\\\ " * 30 + "\\end{pmatrix}") == -1)

    doc = "# T\n\nÖnce.\n\n$$" + loop + "$$\n\nSonra.\n\n$$\nx^2\n$$\n"
    out = truncate_degenerate_math(doc)
    check("note present", DEGENERATE_NOTE in out)
    check("head kept in latex fence", "```latex\n\\begin{array}{l} \\text {for (i = 1;i <   100;i = i + 1) \\{}\n```" in out)
    check("loop dropped", "\\quad \\quad" not in out and len(out) < 600)
    check("good math untouched", "$$\nx^2\n$$" in out and "Önce." in out and "Sonra." in out)

    empty = truncate_degenerate_math("a\n\n$$" + "\\quad " * 500 + "$$\n\nb\n")
    check("no fence when head empty", DEGENERATE_NOTE in empty and "```latex" not in empty)

    inline = "x $$" + "\\quad " * 500 + "$$ y\n"
    check("inline $$ mid-line never a block", truncate_degenerate_math(inline) == inline)
    fenced = "```\n$$" + "\\quad " * 500 + "$$\n```\n"
    check("$$ inside a code fence untouched", truncate_degenerate_math(fenced) == fenced)

    final, _ = postprocess("# T\n\n$$" + loop + "$$\n", title_fallback="x", converted_by="t", needs_review=False)
    warns = quality_warnings(final, is_pdf=True)
    check("warning emitted", any("döngüsü nedeniyle kısaltıldı" in w for w in warns))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    test_wrapping()
    test_alignment_wrapping()
    test_entities()
    test_html_stripping()
    test_warnings()
    test_derive_title()
    test_signature()
    test_degenerate_math()
    print(f"\n{len(failures)} başarısız" if failures else "\nhepsi geçti")
    sys.exit(1 if failures else 0)
