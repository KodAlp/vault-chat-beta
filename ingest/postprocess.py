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
        body = _HBAR_SCRIPT.sub(r"\\hbar \1", match.group(1))
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


def derive_title(text: str, fallback: str) -> str:
    m = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    if not m:
        return fallback
    # K3-7: some web-book HTML wraps a self-referencing anchor around the
    # H1 (e.g. `# [Scanning4](#top)`), which without this would put the
    # literal "[Scanning4](#top)" — brackets, target and all — in the title.
    title = _TITLE_MD_LINK.sub(lambda mm: mm.group(1), m.group(1)).strip()
    return title or fallback


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
