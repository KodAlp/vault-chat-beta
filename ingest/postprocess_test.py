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
    postprocess,
    quality_warnings,
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


def test_signature() -> None:
    # extract_web.py and youtube_transcript.py call postprocess() with this
    # exact shape; adding warnings must not have changed it.
    text, frontmatter = postprocess(
        FIXTURE, title_fallback="fb", converted_by="marker", needs_review=False
    )
    check("postprocess still returns (text, frontmatter)", isinstance(text, str) and isinstance(frontmatter, dict))
    check("title derived from H1", frontmatter["title"] == "Doc")
    check("needs_review omitted when false", "needs_review" not in frontmatter)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    test_wrapping()
    test_alignment_wrapping()
    test_entities()
    test_warnings()
    test_signature()
    print(f"\n{len(failures)} başarısız" if failures else "\nhepsi geçti")
    sys.exit(1 if failures else 0)
