"""Shared post-processing applied to every converter's output before it's
handed back to the Node caller. Kept independent of any one converter so
MarkItDown today and Marker/Docling later (see requirements.txt) all go
through the exact same normalization step.
"""
from __future__ import annotations

import difflib
import html
import re
from datetime import date

_MATH_BLOCK = re.compile(r"\\\[(.*?)\\\]", re.DOTALL)
_MATH_INLINE = re.compile(r"\\\((.*?)\\\)", re.DOTALL)
# Restricted to real HTML tag names (case-insensitive). The old
# `</?[a-zA-Z][^>]{0,200}>` matched *anything* shaped like `<word ...>`, so it
# ate C++ generics and headers wherever they appeared, tagged or not:
# `List<Token>` -> `List`, `<stdio.h>` -> "", `template <typename T>` ->
# `template  T` ("typename"/"Token"/"int"/"stdio.h" are not tag names, so none
# of them match here even outside a code region).
_HTML_TAG_NAMES = (
    "a|abbr|address|area|article|aside|audio|b|base|bdi|bdo|blockquote|body|br|"
    "button|canvas|caption|center|cite|col|colgroup|data|datalist|dd|del|"
    "details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|font|"
    "footer|form|h1|h2|h3|h4|h5|h6|head|header|hr|html|i|iframe|img|input|ins|"
    "kbd|label|legend|li|link|main|map|mark|meta|meter|nav|noscript|object|ol|"
    "optgroup|option|output|p|param|picture|pre|progress|q|rp|rt|ruby|s|samp|"
    "script|section|select|small|source|span|strike|strong|style|sub|summary|"
    "sup|table|tbody|td|textarea|tfoot|th|thead|time|title|tr|track|tt|u|ul|"
    "var|video|wbr"
)
_HTML_TAG = re.compile(rf"</?(?:{_HTML_TAG_NAMES})(?:\s[^>]{{0,200}})?/?>", re.IGNORECASE)
_BLANK_RUN = re.compile(r"\n{3,}")
_HEADING = re.compile(r"^(#{1,6})\s+(.*)$", re.MULTILINE)

_DISPLAY_MATH = re.compile(r"\$\$.*?\$\$", re.DOTALL)
_INLINE_MATH = re.compile(r"\$[^$\n]*?\$")
_FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,}).*?^[ \t]*\1[ \t]*$", re.DOTALL | re.MULTILINE)
_INLINE_CODE = re.compile(r"(`+)(?:(?!\1).)*?\1", re.DOTALL)
# Order matters: at a shared start position (e.g. the first `$` of `$$...$$`),
# re tries alternatives left to right and keeps the first that matches, so
# _DISPLAY_MATH must precede _INLINE_MATH or the latter would match just the
# degenerate `$$` pair instead of the whole block.
_VERBATIM = re.compile(
    "|".join(p.pattern for p in (_FENCE, _DISPLAY_MATH, _INLINE_CODE, _INLINE_MATH)),
    re.DOTALL | re.MULTILINE,
)
_BARE_ENV = re.compile(
    r"\\begin\{(equation|align|gather|multline|alignat|eqnarray)(\*?)\}"
    r".*?"
    r"\\end\{\1\2\}",
    re.DOTALL,
)
_CID = re.compile(r"\(cid:\d+\)")
# 15+ letters with no break is not a word in the languages this library holds;
# it is two or three words the extractor glued together. Never split by
# dictionary (invents errors that read like content); heading_repair.py
# restores spaces only from the PDF's own text layer, and this warning counts
# what that could not prove. Real long words (Controllability) also match, so
# the threshold below matters.
_GLUED_WORDS = re.compile(r"[A-Za-zÇĞİÖŞÜçğıöşü]{15,}")

# Mirrors HARD_MAX_CHARS in indexer/chunk.ts. Beyond it, hardSplit() cuts an
# atomic block mid-token, which breaks LaTeX commands and code lines.
HARD_MAX_CHARS = 2048


# Docling's formula model sometimes loops until its token cap (2048 new tokens
# in docling 2.130's CodeFormulaVlmModel; older versions ~8192), emitting a
# one-line display-math block of several thousand chars made of one 1-4 token
# group repeated hundreds of times. Structural rule, mirrored by DEGENERATE_RUN in
# indexer/chunk.ts (which also repairs already-converted files at index time) —
# change both together.
DEGENERATE_RUN = 100
_MAX_DEGENERATE_GROUP = 4
# Long-period loops (the generator keeps re-reading e.g. "formula (5.29) margin
# label" as one ~20 token group). Needs >= LONG_MIN_REPEATS back-to-back repeats
# AND >= LONG_MIN_TOKENS tokens in total; ingest/formula_early_stop.py applies the
# same rule while generating (periods 5..32 model tokens). Here the group is
# counted in LaTeX tokens, which are finer than model tokens, hence the larger
# cap. A loop runs until the token cap, so after the fact it must also reach the
# end of the block (a legit repeated matrix row is followed by \end{...}), with
# _LONG_TAIL_SLACK trailing tokens allowed to differ (0: a single trailing token
# after the repeats, e.g. `+ c`, already means it is not a runaway loop).
LONG_MIN_REPEATS = 8
LONG_MIN_TOKENS = 64
_MIN_LONG_GROUP = 5
_MAX_LONG_GROUP = 48
_LONG_TAIL_SLACK = 0
_DEGENERATE_HEAD_MAX = 500
_LATEX_TOKEN = re.compile(r"\\[a-zA-Z]+|\\.|[^\s]", re.DOTALL)
DEGENERATE_NOTE = (
    "> ⚠️ Bu formül PDF'ten tam çıkarılamadı (dönüştürücü döngüye girdi) — "
    "kaynak sayfaya bakın."
)
# Line-anchored, like the chunker: a fence or $$ block only opens at the start
# of a line. Fences come first so a $$ line inside code is left alone.
_LINE_FENCE_OR_MATH = re.compile(
    r"(?P<fence>^ {0,3}(?P<f>`{3,}|~{3,})[^\n`]*\n.*?\n {0,3}(?P=f)[`~]*[ \t\r]*$)"
    r"|(?P<math>^ {0,3}\$\$.*?\$\$[ \t\r]*$)",
    re.DOTALL | re.MULTILINE,
)


def long_repeats(group: int) -> int:
    """Back-to-back repeats of a `group`-token group that make a long-period loop."""
    return max(LONG_MIN_REPEATS, -(-LONG_MIN_TOKENS // group))


def _find_long_period_run(toks: list[tuple[str, int]]) -> int:
    """Source offset where a loop of a 5..48 token group that runs to the end of
    the block begins, or -1."""
    best = -1
    for trim in range(_LONG_TAIL_SLACK + 1):
        end = len(toks) - trim
        for g in range(_MIN_LONG_GROUP, _MAX_LONG_GROUP + 1):
            need = g * (long_repeats(g) - 1)
            if end - g < need:
                continue
            i = end - g - 1
            while i >= 0 and toks[i][0] == toks[i + g][0]:
                i -= 1
            if end - g - 1 - i >= need:
                at = toks[i + 1][1]
                if best == -1 or at < best:
                    best = at
    return best


def find_degenerate_run(latex: str) -> int:
    """Source offset where a back-to-back repeat of a token group begins, or -1
    when the formula is not degenerate: a 1-4 token group >= DEGENERATE_RUN
    times anywhere, or a 5..48 token group >= long_repeats() times running to
    the end of the block."""
    toks = [(m.group(0), m.start()) for m in _LATEX_TOKEN.finditer(latex)]
    best = -1
    for g in range(1, _MAX_DEGENERATE_GROUP + 1):
        need = g * (DEGENERATE_RUN - 1)
        run = 0
        run_start = -1
        for i in range(len(toks) - g):
            if toks[i][0] == toks[i + g][0]:
                if run == 0:
                    run_start = i
                run += 1
                if run >= need:
                    at = toks[run_start][1]
                    if best == -1 or at < best:
                        best = at
                    break
            else:
                run = 0
    long_at = _find_long_period_run(toks)
    if long_at != -1 and (best == -1 or long_at < best):
        best = long_at
    return best


def degenerate_math_replacement(latex: str, run_at: int) -> str:
    head = latex[:run_at].strip()
    head = re.sub(r"(\s|\\\\)+$", "", head)
    head = re.sub(r"(\s|\\\\)+$", "", head[:_DEGENERATE_HEAD_MAX]).strip()
    if not head:
        return DEGENERATE_NOTE
    return f"{DEGENERATE_NOTE}\n\n```latex\n{head}\n```"


def truncate_degenerate_math(text: str) -> str:
    """Replaces every looping display-math block with a warning note plus the
    meaningful head (the text before the loop started)."""

    def fix(m: re.Match) -> str:
        if m.group("math") is None:
            return m.group(0)
        raw = m.group("math").rstrip("\r")
        inner = re.sub(r"^ {0,3}\$\$", "", raw)
        inner = re.sub(r"\$\$[ \t]*$", "", inner)
        at = find_degenerate_run(inner)
        if at == -1:
            return m.group(0)
        return degenerate_math_replacement(inner, at)

    return _LINE_FENCE_OR_MATH.sub(fix, text)


def _blank(text: str, start: int, end: int) -> str:
    """Replaces a span with spaces, keeping newlines, so offsets stay valid."""
    kept = re.sub(r"[^\n]", " ", text[start:end])
    return text[:start] + kept + text[end:]


def _mask_verbatim(text: str) -> str:
    """A copy with existing display math and fenced code blanked out, for
    scanning without matching inside them."""
    masked = text
    for pattern in (_FENCE, _DISPLAY_MATH):
        while True:
            m = pattern.search(masked)
            if not m:
                break
            masked = _blank(masked, m.start(), m.end())
    return masked


def normalize_math_delimiters(text: str) -> str:
    """Marker/Docling may emit \\( \\) / \\[ \\] — normalize to $ / $$ so the
    app's renderer (which only special-cases $/$$) handles it uniformly."""
    text = _MATH_BLOCK.sub(lambda m: f"$$ {m.group(1).strip()} $$", text)
    text = _MATH_INLINE.sub(lambda m: f"${m.group(1).strip()}$", text)
    return text


def wrap_bare_math_environments(text: str) -> str:
    """Wraps a top-level \\begin{align}...\\end{align} in $$.

    Not cosmetic. indexer/chunk.ts pulls atomic blocks with a regex that matches
    exactly two things — a ``` fence and a $$...$$ pair. A bare LaTeX
    environment is ordinary text to it, so a derivation written that way can be
    split across two chunks, each half rendering as a KaTeX error. Wrapping it
    is what makes the block atomic.

    Environments already inside $$ or inside a code fence are left alone.
    """
    masked = _mask_verbatim(text)
    spans = [(m.start(), m.end()) for m in _BARE_ENV.finditer(masked)]
    for start, end in reversed(spans):  # right to left: earlier offsets stay valid
        body = text[start:end].strip()
        text = f"{text[:start]}$$\n{body}\n$${text[end:]}"
    return text


def quality_warnings(text: str, *, is_pdf: bool) -> list[str]:
    """Problems worth telling the user about, in Turkish, for the import
    dialog and import-log.jsonl.

    These are warnings, not errors: the file is still written. The point is
    that a conversion can fail completely while producing well-formed Markdown
    — a 22k-line textbook with zero headings and zero equations reads as a
    successful conversion to every automated check that only looks at whether
    the process exited 0.
    """
    warnings: list[str] = []
    lines = [l for l in text.split("\n") if l.strip()]

    cid_count = len(_CID.findall(text))
    if cid_count > 20:
        warnings.append(
            f"{cid_count} adet (cid:NN) artığı — PDF'in font eşlemesi çözülemedi, "
            "metnin bir kısmı (çoğunlukla formüller) kayıp olabilir"
        )

    # Old TeX PDFs (CMSY/CMMI fonts embedded without /ToUnicode) make every
    # extractor emit U+FFFD for primes, Delta etc. (measured 2026-10-08: 67 of
    # 702 course PDFs). The note otherwise reads as clean, so say it plainly.
    bad_chars = text.count("\ufffd") if is_pdf else 0
    if bad_chars:
        warnings.append(
            f"{bad_chars} bozuk karakter (\ufffd) kaldı: kaynak PDF'te yazı tipi eşlemesi eksik "
            "(genelde eski TeX yazı tipleri); bu yerleri kaynakla karşılaştırın."
        )

    if is_pdf and len(lines) > 200 and not re.search(r"^##\s", text, re.MULTILINE):
        warnings.append(
            "hiç ## başlığı yok — indeksleyici tüm dosyayı tek bir bölüm olarak "
            "parçalar, getirilen her chunk aynı breadcrumb'ı taşır"
        )

    if len(text) > 5000:
        blank_ratio = text.count("\n\n") / max(len(text) / 1000, 1)
        if blank_ratio < 1:
            warnings.append(
                "paragraflar boş satırla ayrılmamış — parçalayıcının "
                "kullanabileceği sınır yok"
            )

    headings = re.findall(r"^#{2,6}\s+(.*)$", text, re.MULTILINE)
    if headings:
        glued = [h for h in headings if _GLUED_WORDS.search(h)]
        if len(glued) > max(3, len(headings) // 10):
            warnings.append(
                f"{len(glued)}/{len(headings)} başlıkta kelimeler bitişik "
                "(\"Linearcontrolsystems\") — çıkarıcı kelime aralarını kaybetmiş. "
                "heading_path gömülü metnin parçası olduğu için bu doğrudan "
                "retrieval doğruluğunu düşürür; başlıklar elle düzeltilmeli"
            )

    looped = text.count(DEGENERATE_NOTE)
    if looped:
        warnings.append(f"{looped} formül bloğu dönüştürücü döngüsü nedeniyle kısaltıldı")

    oversize = 0
    for pattern in (_FENCE, _DISPLAY_MATH):
        oversize += sum(1 for m in pattern.finditer(text) if len(m.group(0)) > HARD_MAX_CHARS)
    if oversize:
        warnings.append(
            f"{oversize} atomik blok {HARD_MAX_CHARS} karakteri aşıyor — "
            "hardSplit() bunları kelime ortasından kesecek"
        )

    return warnings


def wrap_alignment_math(text: str) -> str:
    """Wraps a $$ block that uses `&` alignment markers in \\begin{aligned}.

    Docling emits multi-line aligned equations as bare `a & = b \\\\ c & = d`,
    with no alignment environment around them. KaTeX rejects `&` outside one, so
    the block renders as a red error. Measured on 12 equation-dense pages of
    Trentelman: 5 of 63 decoded formulas failed for exactly this reason.

    Only blocks that use `&` and declare no environment of their own are
    touched — an existing \\begin{...} is left alone.
    """

    def fix(match: re.Match) -> str:
        body = match.group(1).strip()
        if "&" not in body or "\\begin{" in body:
            return match.group(0)
        # A trailing row separator would open an empty final row.
        body = re.sub(r"\\\\\s*$", "", body).strip()
        return "$$\\begin{aligned}" + body + "\\end{aligned}$$"

    return re.sub(r"\$\$(.*?)\$\$", fix, text, flags=re.DOTALL)


_HBAR_SCRIPT = re.compile(r"\\hbar\s*\{\s*([\^_])\s*\}")
_ACCENT_AFTER_FONT = re.compile(
    r"\\(mathbf|boldsymbol|bm|mathrm|mathit|mathsf|mathcal)\s+\\(dot|ddot|hat|tilde|bar|vec|widehat|widetilde|overline)\s*\{"
)
_DISPLAY_BREAK = re.compile(r"\\\]\s*\\\[")
_DISPLAY_DELIM = re.compile(r"\\[\[\]]")
# Prose = at least two real words ("where we", "is the"); backslashes only inside $...$.
_DISPLAY_PROSE = re.compile(
    r"\\\]\s*((?=(?:[^\\$]|\$[^$]*\$)*?[A-Za-z]{3,}\s+[A-Za-z]{2,})[^\\$]*(?:\$[^$]*\$[^\\$]*)*)\s*\\\[", re.DOTALL
)
_INTERTEXT = re.compile(r"\\intertext(?![A-Za-z])")
# `\hbar {` as one unit followed by a command that needs an argument: `\hbar { \hat } { y }`.
_HBAR_CMD = re.compile(r"\\hbar\s*\{\s*(\\(?:hat|widehat|sqrt|tilde|widetilde|bar|overline|vec|dot|ddot|frac|mathbf|mathrm|boldsymbol))\s*\}")
# `\Big { | }`: KaTeX wants the delimiter itself, not a group.
_SIZED_DELIM = re.compile(r"\\(big|Big|bigg|Bigg)([lrm]?)\s*\{\s*(\\[|{}]|\\langle|\\rangle|\\vert|\\Vert|[|()\[\]/.])\s*\}")
_SCRIPT = re.compile(r"\s*([_^])\s*")
_COMMAND = re.compile(r"\\(?:[A-Za-z]+|.)?", re.DOTALL)  # a lone trailing backslash matches as itself
_MATH_ENV = re.compile(r"\s*\\begin\{(aligned|align\*?|gathered|gather\*?|array|split)\}(\{[^{}]*\})?(.*)\\end\{\1\}\s*$", re.DOTALL)
_PROSE_WORDS = re.compile(r"[A-Za-z]{2,}[,.;:]?\s+[A-Za-z]{2,}[,.;:]?\s+[A-Za-z]{2,}")
_SPACED_LETTERS = re.compile(r"(?:\b[A-Za-z] ){6,}")
_ROW_FILLER = re.compile(r"^(?:\s|&|\\quad|\\qquad|\\[,;:! ])*|(?:\s|&|\\quad|\\qquad|\\[,;:! ])*$")


def _group_end(s: str, i: int) -> int:
    """Index just past the brace group opening at s[i] == '{' (escaped characters skipped); -1 if unbalanced."""
    depth = 0
    j = i
    while j < len(s):
        c = s[j]
        if c == "\\":
            j += 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    return -1


def _script_end(s: str, i: int) -> int:
    """End of the script argument starting at s[i] (a group, a command or one character); -1 if none."""
    if i >= len(s):
        return -1
    if s[i] == "{":
        return _group_end(s, i)
    if s[i] == "\\":
        return _COMMAND.match(s, i).end()
    return i + 1


def _separate_double_scripts(body: str) -> str:
    """`x _ {a} ^ {b} _ {c}` / `z ^ {\\prime} ^ {2}` (tensor indices, primes) are "Double subscript/superscript"
    errors in KaTeX; an empty group before the repeated script fixes them: `x_{a}^{b}{}_{c}`."""
    out = []
    i = 0
    seen: set[str] = set()
    while i < len(body):
        m = _SCRIPT.match(body, i)
        if m:
            end = _script_end(body, m.end())
            if end > 0:
                kind = m.group(1)
                if kind in seen:
                    out.append("{}")
                    seen = set()
                seen.add(kind)
                out.append(body[i:end])
                i = end
                continue
        c = body[i]
        if not c.isspace():
            seen = set()
        if c == "\\":
            n = _COMMAND.match(body, i).end() - i
            out.append(body[i:i + n])
            i += n
            continue
        if c == "{":
            end = _group_end(body, i)
            if end > 0:
                out.append("{" + _separate_double_scripts(body[i + 1:end - 1]) + "}")
                i = end
                continue
        out.append(c)
        i += 1
    return "".join(out)


def _split_rows(inner: str) -> list[str]:
    """Rows of an alignment body, split on `\\\\` at brace depth 0 outside nested environments."""
    rows, depth, env, start, i = [], 0, 0, 0, 0
    while i < len(inner):
        if inner.startswith("\\begin{", i):
            env += 1
        elif inner.startswith("\\end{", i):
            env -= 1
        c = inner[i]
        if c == "\\" and i + 1 < len(inner) and inner[i + 1] == "\\" and depth == 0 and env == 0:
            rows.append(inner[start:i])
            i += 2
            start = i
            continue
        if c == "\\":
            i += 2
            continue
        depth += c == "{"
        depth -= c == "}"
        i += 1
    rows.append(inner[start:])
    return rows


def _prose_row(row: str) -> str | None:
    r"""The sentence, if the row is nothing but one `\text{...}` holding running text (the crop caught a line of
    the page); None for formula rows and for short text that belongs to the formula (`\text{for all } x`)."""
    core = _ROW_FILLER.sub("", row)
    m = re.match(r"\\(?:text|textrm|mbox)\s*\{", core)
    if not m or _group_end(core, m.end() - 1) != len(core):
        return None
    content = core[m.end():-1].strip()
    if _PROSE_WORDS.search(content) or _SPACED_LETTERS.search(content + " "):
        return content
    return None


def _letters(s: str) -> str:
    return re.sub(r"[^a-z]", "", s.lower())


def _already_in(prose: str, nearby: str) -> bool:
    """Is this caught line already in the note's own text around the block? The crop usually catches a line
    docling ALSO extracted as text, often misread ("string signal model" for "string sigma-model"), so moving
    it out would duplicate it. Present = at least 70% of the line's letters fall in in-order runs of >= 4
    letters of the nearby text (97 of 103 Fizik lines; the 6 below 0.65 were truly absent). Fragments under
    12 letters count as present."""
    a = _letters(prose)
    if len(a) < 12:
        return True
    b = _letters(nearby)
    blocks = difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks()
    return sum(x.size for x in blocks if x.size >= 4) >= 0.7 * len(a)


def _move_prose_out(body: str, nearby: str = "") -> str | None:
    """Splits an alignment block whose rows include running text into math blocks and plain paragraphs;
    None when nothing is prose. Each math part keeps the original environment. A caught line that the
    surrounding text already contains is dropped instead of duplicated."""
    m = _MATH_ENV.match(body)
    env, spec, inner = (m.group(1), m.group(2) or "", m.group(3)) if m else (None, "", body)
    rows = _split_rows(inner)
    prose = [_prose_row(r) for r in rows]
    if not any(p is not None for p in prose):
        return None
    parts, math_rows = [], []

    def flush() -> None:
        kept = [r for r in math_rows if r.strip()]
        if kept:
            joined = " \\\\ ".join(r.strip() for r in kept)
            parts.append("$$" + (f"\\begin{{{env}}}{spec}{joined}\\end{{{env}}}" if env else joined) + "$$")
        math_rows.clear()

    for row, p in zip(rows, prose):
        if p is None:
            math_rows.append(row)
        else:
            flush()
            if not _already_in(p, nearby):
                parts.append(p)
    flush()
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Symbol-font private-use codes (Likharev PDFs, measured 2026-10-13)
# ---------------------------------------------------------------------------
# Some PDFs (Likharev's physics lecture notes) set maths in the Adobe Symbol
# font and their text layer exposes the glyphs as U+F000 + <Symbol byte>
# (U+F0B5 = proportional-to, U+F0A5 = infinity, U+F066 = phi ...); ~5000 such
# characters per note. They render as tofu and match no search. The standard
# Adobe Symbol encoding (bytes 0x20-0xFE) maps them to real Unicode.
# scripts/symbol-propto-repair.mjs carries the same table for notes that are
# already in a library -- change both together (both tests pin the same codes).
_SYMBOL_ASCII = " !\u2200#\u2203%&\u220b()\u2217+,\u2212./0123456789:;<=>?\u2245"  # bytes 0x20-0x40
_SYMBOL_GREEK_UP = "\u0391\u0392\u03a7\u0394\u0395\u03a6\u0393\u0397\u0399\u03d1\u039a\u039b\u039c\u039d\u039f\u03a0\u0398\u03a1\u03a3\u03a4\u03a5\u03c2\u03a9\u039e\u03a8\u0396"  # 0x41-0x5A
_SYMBOL_GREEK_LOW = "\u03b1\u03b2\u03c7\u03b4\u03b5\u03c6\u03b3\u03b7\u03b9\u03d5\u03ba\u03bb\u03bc\u03bd\u03bf\u03c0\u03b8\u03c1\u03c3\u03c4\u03c5\u03d6\u03c9\u03be\u03c8\u03b6"  # 0x61-0x7A
_SYMBOL_OTHER = {
    0x5B: "[", 0x5C: "\u2234", 0x5D: "]", 0x5E: "\u22a5", 0x5F: "_", 0x60: "\u203e",
    0x7B: "{", 0x7C: "|", 0x7D: "}", 0x7E: "\u223c",
    0xA0: "\u20ac", 0xA1: "\u03d2", 0xA2: "\u2032", 0xA3: "\u2264", 0xA4: "\u2044", 0xA5: "\u221e",
    0xA6: "\u0192", 0xA7: "\u2663", 0xA8: "\u2666", 0xA9: "\u2665", 0xAA: "\u2660", 0xAB: "\u2194",
    0xAC: "\u2190", 0xAD: "\u2191", 0xAE: "\u2192", 0xAF: "\u2193", 0xB0: "\u00b0", 0xB1: "\u00b1",
    0xB2: "\u2033", 0xB3: "\u2265", 0xB4: "\u00d7", 0xB5: "\u221d", 0xB6: "\u2202", 0xB7: "\u2022",
    0xB8: "\u00f7", 0xB9: "\u2260", 0xBA: "\u2261", 0xBB: "\u2248", 0xBC: "\u2026", 0xBD: "\u23d0",
    0xBE: "\u23af", 0xBF: "\u21b5", 0xC0: "\u2135", 0xC1: "\u2111", 0xC2: "\u211c", 0xC3: "\u2118",
    0xC4: "\u2297", 0xC5: "\u2295", 0xC6: "\u2205", 0xC7: "\u2229", 0xC8: "\u222a", 0xC9: "\u2283",
    0xCA: "\u2287", 0xCB: "\u2284", 0xCC: "\u2282", 0xCD: "\u2286", 0xCE: "\u2208", 0xCF: "\u2209",
    0xD0: "\u2220", 0xD1: "\u2207", 0xD2: "\u00ae", 0xD3: "\u00a9", 0xD4: "\u2122", 0xD5: "\u220f",
    0xD6: "\u221a", 0xD7: "\u22c5", 0xD8: "\u00ac", 0xD9: "\u2227", 0xDA: "\u2228", 0xDB: "\u21d4",
    0xDC: "\u21d0", 0xDD: "\u21d1", 0xDE: "\u21d2", 0xDF: "\u21d3", 0xE0: "\u25ca", 0xE1: "\u27e8",
    0xE2: "\u00ae", 0xE3: "\u00a9", 0xE4: "\u2122", 0xE5: "\u2211", 0xE6: "\u239b", 0xE7: "\u239c",
    0xE8: "\u239d", 0xE9: "\u23a1", 0xEA: "\u23a2", 0xEB: "\u23a3", 0xEC: "\u23a7", 0xED: "\u23a8",
    0xEE: "\u23a9", 0xEF: "\u23aa", 0xF1: "\u27e9", 0xF2: "\u222b", 0xF3: "\u2320", 0xF4: "\u23ae",
    0xF5: "\u2321", 0xF6: "\u239e", 0xF7: "\u239f", 0xF8: "\u23a0", 0xF9: "\u23a4", 0xFA: "\u23a5",
    0xFB: "\u23a6", 0xFC: "\u23ab", 0xFD: "\u23ac", 0xFE: "\u23ad",
}
# Byte 0x66 is Adobe's "phi" -> U+03C6 (phi), byte 0x6A "phi1" -> U+03D5; both are in the letter runs above.
SYMBOL_PUA: dict[str, str] = {chr(0xF020 + i): c for i, c in enumerate(_SYMBOL_ASCII)}
SYMBOL_PUA.update({chr(0xF041 + i): c for i, c in enumerate(_SYMBOL_GREEK_UP)})
SYMBOL_PUA.update({chr(0xF061 + i): c for i, c in enumerate(_SYMBOL_GREEK_LOW)})
SYMBOL_PUA.update({chr(0xF000 + b): c for b, c in _SYMBOL_OTHER.items()})
_SYMBOL_PUA_RE = re.compile("[\uf020-\uf0fe]")


def map_symbol_pua(text: str) -> str:
    """Maps Adobe-Symbol private-use codes (U+F0xx) to Unicode.

    Runs on the whole document EXCEPT fenced and inline code, and it includes
    math: a raw U+F0B5 inside `$$ ... $$` is as unreadable as in prose, and the
    replacements (propto, infinity, Greek, arrows ...) are all characters KaTeX
    accepts. Code is skipped because a private-use character there is data we
    must not rewrite. A code with no entry (U+F0F0 = Apple logo) stays as it is.
    """
    if not _SYMBOL_PUA_RE.search(text):
        return text

    def sub(chunk: str) -> str:
        return _SYMBOL_PUA_RE.sub(lambda m: SYMBOL_PUA.get(m.group(0), m.group(0)), chunk)

    def sub_outside_inline(chunk: str) -> str:
        parts: list[str] = []
        p = 0
        for m in _INLINE_CODE.finditer(chunk):
            parts.append(sub(chunk[p : m.start()]))
            parts.append(m.group(0))
            p = m.end()
        parts.append(sub(chunk[p:]))
        return "".join(parts)

    out: list[str] = []
    pos = 0
    for m in _FENCE.finditer(text):
        out.append(sub_outside_inline(text[pos : m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(sub_outside_inline(text[pos:]))
    return "".join(out)


# ---------------------------------------------------------------------------
# \infty read where the PDF has "proportional to" (TODO #4, measured 2026-10-13)
# ---------------------------------------------------------------------------
# CodeFormula writes `\, \infty \,` for the symbol propto (and sometimes `\, \alpha \,`).
# It is valid LaTeX, so no KaTeX/structure check ever flagged it. Measured on 18
# Fizik notes: 71 candidates between two terms, 70 verified as propto in the PDF text
# layer (the one miss: `\infty \text {-category}`); 1,792 other \infty untouched.
# scripts/symbol-propto-repair.mjs implements the same rule -- change both together.
_TERM_END_CMDS = frozenset(
    "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi "
    "varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi "
    "Pi Sigma Upsilon Phi Psi Omega hbar ell partial aleph imath jmath Re Im".split()
)
_TERM_START_CMDS = _TERM_END_CMDS | frozenset(
    "frac dfrac tfrac sqrt left mathrm mathbf mathit mathcal mathbb boldsymbol text textrm operatorname "
    "vec hat bar dot ddot tilde overline nabla sin cos tan exp ln log int sum prod".split()
)
_SPACING_BACK = (r"\,", r"\;", r"\ ", r"\quad")
_SPACING_FWD = re.compile(r"\\(?:,|;| |quad(?![a-zA-Z]))|\s")
_INFTY = re.compile(r"\\infty(?![a-zA-Z])")
_NO_DASH_TEXT = re.compile(r"\\(?:text|textrm|mathrm)\s*\{\s*-")
_SPACED_ALPHA = re.compile(r"(\\,\s*)\\alpha(?![a-zA-Z])(\s*\\,)")


def _skip_spacing_back(s: str, i: int) -> int:
    """Index just past the last non-spacing character of s[:i]."""
    while i > 0:
        for cand in _SPACING_BACK:
            if s.endswith(cand, 0, i):
                i -= len(cand)
                break
        else:
            if not s[i - 1].isspace():
                return i
            i -= 1
    return i


def _skip_spacing_fwd(s: str, i: int) -> int:
    while i < len(s):
        m = _SPACING_FWD.match(s, i)
        if not m:
            return i
        i = m.end()
    return i


def _in_script_group(s: str, pos: int) -> bool:
    """True when s[pos] sits inside a `{...}` group that is a sub/superscript argument."""
    depth = 0
    for i in range(pos - 1, -1, -1):
        if i > 0 and s[i - 1] == "\\":
            continue
        if s[i] == "}":
            depth += 1
        elif s[i] == "{":
            if depth == 0:
                j = i
                while j > 0 and s[j - 1].isspace():
                    j -= 1
                if j > 0 and s[j - 1] in "_^":
                    return True
            else:
                depth -= 1
    return False


def _prev_is_term_end(s: str, end: int) -> bool:
    """Is the last meaningful token of s[:end] the end of a term?"""
    if end <= 0:
        return False
    if s.endswith(r"\}", 0, end) or s.endswith(r"\right|", 0, end):
        return True
    ch = s[end - 1]
    if ch in ")]":
        return True
    if ch == "}":
        return True
    if ch.isascii() and ch.isdigit():
        return True
    if ch.isascii() and ch.isalpha():
        j = end
        while j > 0 and s[j - 1].isascii() and s[j - 1].isalpha():
            j -= 1
        if j > 0 and s[j - 1] == "\\":
            return s[j:end] in _TERM_END_CMDS
        return True
    return False


def _next_is_term_start(s: str, i: int) -> bool:
    if i >= len(s) or _NO_DASH_TEXT.match(s, i):
        return False
    ch = s[i]
    if ch == "\\":
        m = re.match(r"\\([A-Za-z]+)", s[i:])
        return bool(m) and m.group(1) in _TERM_START_CMDS
    return ch in "([{" or (ch.isascii() and (ch.isdigit() or ch.isalpha()))


def fix_propto(body: str) -> str:
    r"""`\infty` between two terms (and a two-side-spaced `\, \alpha \,`) -> `\propto`.

    `\infty` stays when it is a script argument or follows `_` `^` (limits, sums), follows an operator
    or relation (`=`, `\to`, `\pm`, `-`, `(`, `[`, `,`), or is followed by `\text{-...}` ("\infty-category").
    Neighbours are looked at past `\,` `\;` `\ ` `\quad`.
    """
    if "\\infty" not in body and "\\alpha" not in body:
        return body
    out: list[str] = []
    pos = 0
    for m in _INFTY.finditer(body):
        a = _skip_spacing_back(body, m.start())
        b = _skip_spacing_fwd(body, m.end())
        if _prev_is_term_end(body, a) and _next_is_term_start(body, b) and not _in_script_group(body, m.start()):
            out.append(body[pos : m.start()])
            out.append("\\propto")
            pos = m.end()
    out.append(body[pos:])
    body = "".join(out)
    return _SPACED_ALPHA.sub(lambda m: m.group(1) + "\\propto" + m.group(2), body)


def fix_latex_artifacts(text: str) -> str:
    r"""Deterministic repairs of recurring formula-model artifacts inside $$ blocks (each is a KaTeX error).

    Measured on the 18 Fizik notes after the 2026-10-10 re-conversion (466 KaTeX errors left):
      * CodeFormulaV2 emits `\hbar {` as one unit, so hbar squared comes out as `\hbar { ^ } { 2 }`
        (947 occurrences, 361 failing blocks): `{ ^ }` / `{ _ }` -> `^` / `_`. Other `\hbar { x }` forms
        render correctly and are left alone.
      * A font command whose argument is an accent, `\mathbf \dot { p }` -> `\mathbf { \dot { p } }`.
      * MinerU (formula fallback) separates several equations with `\] \[` inside one block -> row break;
        any other stray `\[` / `\]` is dropped (never valid inside math).
    """

    def fix(match: re.Match) -> str:
        body = fix_propto(_HBAR_SCRIPT.sub(r"\\hbar \1", match.group(1)))
        out = []
        pos = 0
        for m in _ACCENT_AFTER_FONT.finditer(body):
            end = _group_end(body, m.end() - 1)
            if end < 0 or m.start() < pos:
                continue
            out.append(body[pos:m.start()])
            out.append("\\" + m.group(1) + " { \\" + m.group(2) + " " + body[m.end() - 1:end] + " }")
            pos = end
        body = "".join(out) + body[pos:]
        body = _INTERTEXT.sub(r"\\text", body)
        body = _HBAR_CMD.sub(r"\\hbar \1", body)
        body = _SIZED_DELIM.sub(r"\\\1\2\3", body)
        if re.search(r"[_^]\s*(?:\{[^{}]*\}|\\[A-Za-z]+|\S)\s*[_^]", body):
            body = _separate_double_scripts(body)
        if "\\[" in body or "\\]" in body:
            body = _DISPLAY_BREAK.sub(r" \\\\ ", body)
            # `\] prose \[`: the crop caught a line of running text between two displays (or after the last /
            # before the first one) -> move it out of math.
            if body.rfind("\\]") > body.rfind("\\["):
                body += " \\["
            if 0 <= body.find("\\[") < (body.find("\\]") if "\\]" in body else len(body)):
                body = "\\] " + body
            parts = _DISPLAY_PROSE.split(body)
            if len(parts) > 1:
                blocks = []
                for k, part in enumerate(parts):
                    part = _DISPLAY_DELIM.sub(" ", part).strip()
                    if part and not (k % 2 and _already_in(part, nearby(match))):
                        blocks.append(part if k % 2 else "$$" + part + "$$")
                return "\n\n".join(blocks)
            body = _DISPLAY_DELIM.sub(" ", body)
        if "\\text" in body:
            split = _move_prose_out(body, nearby(match))
            if split is not None:
                return split
        return "$$" + body + "$$"

    spans = [m.span() for m in re.finditer(r"\$\$.*?\$\$", text, flags=re.DOTALL)]

    def nearby(match: re.Match) -> str:
        """Plain text within ~2000 characters of the block, every math block cut out by its position (a regex
        over a window that starts inside a block would pair the wrong `$$` and swallow real text)."""
        lo, hi = max(0, match.start() - 2000), min(len(text), match.end() + 2000)
        out, pos = [], lo
        for s, e in spans:
            if e <= lo or s >= hi:
                continue
            out.append(text[pos:max(pos, s)])
            pos = max(pos, e)
        out.append(text[pos:hi])
        return " ".join(out)

    return re.sub(r"\$\$(.*?)\$\$", fix, text, flags=re.DOTALL)


def decode_html_entities(text: str) -> str:
    """Converters leak entities into prose and into math: docling wrote
    `|λ| &lt; 1` into the body verbatim.

    Runs *after* tag stripping, never before: decoding first would turn
    `&lt;something&gt;` into `<something>`, which the tag stripper would then
    delete as markup.
    """
    return html.unescape(text)


def _apply_outside_verbatim(text: str, fn) -> str:
    """Runs `fn` on every span of `text` that is not fenced code, inline code,
    or math ($…$/$$…$$) — those spans are copied through untouched.

    Ö5: the HTML-tag stripper used to run over the whole document, so
    `#include <stdio.h>` inside a fenced code block and `$a<b$ … $c>d$` both
    lost content to a regex that had no idea it was looking at code or math.
    """
    out: list[str] = []
    pos = 0
    for m in _VERBATIM.finditer(text):
        out.append(fn(text[pos : m.start()]))
        out.append(m.group(0))  # verbatim: copied through, never transformed
        pos = m.end()
    out.append(fn(text[pos:]))
    return "".join(out)


def strip_html_remnants(text: str) -> str:
    return _apply_outside_verbatim(text, lambda chunk: _HTML_TAG.sub("", chunk))


def collapse_blank_lines(text: str) -> str:
    return _BLANK_RUN.sub("\n\n", text)


def fix_heading_jumps(text: str) -> str:
    """No H1->H3 skips — the chunker (indexer/chunk.ts) depends on a sane
    heading tree. Walks headings in document order and never lets a level
    increase by more than one step at a time."""
    lines = text.split("\n")
    prev_level = 0
    out = []
    for line in lines:
        m = _HEADING.match(line)
        if not m:
            out.append(line)
            continue
        level = len(m.group(1))
        if level > prev_level + 1:
            level = prev_level + 1
        prev_level = level
        out.append(f"{'#' * level} {m.group(2)}")
    return "\n".join(out)


_TITLE_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")


# Titles that no human wrote: what a generator puts in /Title or on a default
# slide (2026-10-10 real imports: "PowerPoint Sunusu", "PowerPoint Presentation").
_GENERIC_TITLE = re.compile(
    r"^(?:"
    r"(?:microsoft\s+)?power\s?point(?:\s+(?:presentation|sunusu))?(?:\s*\d+)?"
    r"|(?:microsoft\s+)?word(?:\s+document)?"
    r"|untitled(?:\s+(?:document|presentation|slide))?(?:\s*\d+)?"
    r"|ba[sş]l[ıi]ks[ıi]z(?:\s+(?:belge|sunu))?(?:\s*\d+)?"
    r"|(?:document|presentation|sunum|belge|slide|slayt|folie)\s*\d*"
    r"|slide\s+title|click\s+to\s+add\s+title|title(?:\s+(?:page|slide))?|cover(?:\s+page)?"
    r")$",
    re.IGNORECASE,
)
# "Microsoft Word - report.doc", "Microsoft PowerPoint - [deck.ppt]"
_GENERATOR_PREFIX = re.compile(r"^microsoft\s+(?:word|powerpoint|excel)\s*-\s", re.IGNORECASE)
# An edition label with at most three qualifying words is a cover line, not a title.
_EDITION_ONLY = re.compile(
    r"^(?:[^\W\d_]+\s+){0,3}(?:edition|ed\.|bask[ıi]s[ıi]|bask[ıi]|s[üu]r[üu]m[üu]?)$"
    r"|^\d+(?:st|nd|rd|th)\s+(?:edition|ed\.)$",
    re.IGNORECASE,
)
_FILE_NAME_TITLE = re.compile(r"\.(?:pdf|docx?|pptx?|xlsx?|tex|md|txt)$", re.IGNORECASE)
# A part/chapter number standing alone ("I", "XIV", "12"). Upper-case I/V/X only:
# a lone "C" or "D" is likelier a language or a grade, and "Vi" an editor.
_PART_NUMBER_ONLY = re.compile(r"^(?:[IVX]+|\d+)\.?$")


def is_junk_title(title: str | None) -> bool:
    """True when `title` cannot serve as a note title: empty, no real
    characters (``******``), a bare part number (``I``, ``XIV``, ``12``), a generator
    default (PowerPoint Presentation / Sunusu, Untitled, Slide 1, "Microsoft
    Word - ..."), an edition label alone (Expanded Edition), or a file name.
    Short real titles ("Go", "R", "C", "Qt") are kept.
    The caller then tries its next candidate (next heading, metadata, file name)."""
    if not title:
        return True
    t = " ".join(title.split())
    if not any(ch.isalnum() for ch in t) or _PART_NUMBER_ONLY.match(t):
        return True
    return bool(
        _GENERIC_TITLE.match(t)
        or _GENERATOR_PREFIX.match(t)
        or _EDITION_ONLY.match(t)
        or _FILE_NAME_TITLE.search(t)
    )


def derive_title(text: str, fallback: str) -> str:
    # K3-7: some web-book HTML wraps a self-referencing anchor around the
    # H1 (e.g. `# [Scanning4](#top)`), which without this would put the
    # literal "[Scanning4](#top)" — brackets, target and all — in the title.
    # The first H1 that is not junk wins; a junk-only body falls back.
    for m in re.finditer(r"^#\s+(.+)$", text, re.MULTILINE):
        title = _TITLE_MD_LINK.sub(lambda mm: mm.group(1), m.group(1)).strip()
        if not is_junk_title(title):
            return title
    return fallback


def build_frontmatter(title: str, converted_by: str, needs_review: bool) -> dict:
    """Only the fields convert.py can actually know. domain/level are filled
    in by the Node confirm step (the user's chosen target folder / an
    editable default), never guessed here."""
    fm = {
        "title": title,
        "converted_by": converted_by,
        "converted_at": date.today().isoformat(),
    }
    if needs_review:
        fm["needs_review"] = True
    return fm


def postprocess(text: str, *, title_fallback: str, converted_by: str, needs_review: bool) -> tuple[str, dict]:
    text = map_symbol_pua(text)
    text = normalize_math_delimiters(text)
    text = truncate_degenerate_math(text)
    text = fix_latex_artifacts(text)
    text = wrap_bare_math_environments(text)
    text = wrap_alignment_math(text)
    text = strip_html_remnants(text)
    text = decode_html_entities(text)
    text = fix_heading_jumps(text)
    text = collapse_blank_lines(text).strip() + "\n"
    title = derive_title(text, title_fallback)
    frontmatter = build_frontmatter(title, converted_by, needs_review)
    return text, frontmatter
