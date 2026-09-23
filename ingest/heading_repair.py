"""Restores the spaces docling drops from PDF headings.

Measured on Trentelman's 404-page control theory book: 98 of 194 `##`
headings came out glued (`1.3 Linearcontrolsystems`). `heading_path` is part
of the embedded text, so those sections lose their retrieval key.

Dictionary word-splitting was rejected because it invents boundaries that read
like content. This repair invents nothing: the PDF's own text layer (read by
pypdf, already a dependency) carries the same heading with its spaces, so a
heading is repaired only when

- its letters and digits match a text-layer line (or 2-3 consecutive lines,
  for wrapped headings) exactly, character for character, and
- every space it already has is also in that line — it is only *missing*
  spaces, never has different ones, and
- all matching lines agree on where the spaces go.

Anything else is left untouched and still counted by quality_warnings().
"""
from __future__ import annotations

import re
import unicodedata
from pathlib import Path

_HEADING_LINE = re.compile(r"^(#{1,6}[ \t]+)(.+?)[ \t]*$", re.MULTILINE)
_SECTION_NUMBER = re.compile(r"(?:\d+|[A-Z](?=\.))(?:\.\d+)*\.?\s+")
# Wrapped headings span at most a few lines on the page.
_MAX_WINDOW = 3


def _profile(text: str) -> tuple[tuple[str, ...], frozenset[int]]:
    """(casefolded alphanumerics, indices k where whitespace precedes alnum k)."""
    chars: list[str] = []
    boundaries: set[int] = set()
    saw_space = False
    for c in unicodedata.normalize("NFKC", text):
        if c.isalnum():
            if saw_space and chars:
                boundaries.add(len(chars))
            chars.append(c.casefold())
            saw_space = False
        elif c.isspace():
            saw_space = True
    return tuple(chars), frozenset(boundaries)


def build_reference(lines: list[str]) -> dict[tuple[str, ...], set[frozenset[int]]]:
    """Maps a line's alphanumeric key to every spacing seen for it."""
    ref: dict[tuple[str, ...], set[frozenset[int]]] = {}
    stripped = [l.strip() for l in lines]
    for i in range(len(stripped)):
        for w in range(1, _MAX_WINDOW + 1):
            window = stripped[i : i + w]
            if len(window) < w or not all(window):
                break
            key, spaces = _profile(" ".join(window))
            if len(key) >= 4:
                ref.setdefault(key, set()).add(spaces)
    return ref


def _respace(heading: str, spaces: frozenset[int]) -> str:
    out: list[str] = []
    k = 0
    for c in unicodedata.normalize("NFKC", heading):
        if c.isalnum():
            if k in spaces and out and not out[-1].isspace():
                out.append(" ")
            k += 1
        out.append(c)
    return "".join(out)


def _repair_one(heading: str, ref: dict) -> str | None:
    repaired = _repair_exact(heading, ref)
    if repaired is not None:
        return repaired
    # The section number is often a separate span in the text layer
    # ("1.3" then "Linear control systems" on the next line, or no number at
    # all on the chapter's first page), so also try the title alone.
    m = _SECTION_NUMBER.match(heading)
    if m and m.end() < len(heading):
        rest = _repair_exact(heading[m.end() :], ref)
        if rest is not None:
            return heading[: m.end()] + rest
    return None


def _repair_exact(heading: str, ref: dict) -> str | None:
    key, own = _profile(heading)
    candidates = ref.get(key)
    if not candidates:
        return None
    fitting = {c for c in candidates if own <= c and own != c}
    if len(fitting) != 1 or own in candidates:
        # Ambiguous, or the text layer already has it spaced exactly as is.
        return None
    return _respace(heading, next(iter(fitting)))


def _heading_indices(lines: list[str]) -> list[int]:
    """Indices of heading lines, skipping fenced code — a `# comment` in a
    Python block is not a heading and must never be respaced or demoted."""
    out: list[int] = []
    fence: str | None = None
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        marker = re.match(r"(`{3,}|~{3,})", stripped)
        if marker:
            if fence is None:
                fence = marker.group(1)[0] * 3
            elif stripped.startswith(fence):
                fence = None
            continue
        if fence is None and _HEADING_LINE.match(line):
            out.append(i)
    return out


def repair_headings(markdown: str, reference_lines: list[str]) -> tuple[str, int]:
    """Returns (markdown with repaired headings, number of headings changed)."""
    ref = build_reference(reference_lines)
    lines = markdown.split("\n")
    changed = 0
    for i in _heading_indices(lines):
        m = _HEADING_LINE.match(lines[i])
        repaired = _repair_one(m.group(2), ref)
        if repaired is not None:
            lines[i] = m.group(1) + repaired
            changed += 1
    return "\n".join(lines), changed


# --- Pseudo-headings -------------------------------------------------------
#
# docling promotes run-in labels to `##`: `Theorem 2.19`, `Proof :`,
# `Remarks:`, `Example 3.9 Let`, exercise items `3.12 Let`. They pollute
# heading_path for every chunk under them. A word list (Theorem, Proof, …)
# would fail on Turkish and every other language, so the signal is the
# typography instead: in the text layer real headings are set larger than the
# body (Trentelman: body 10.0 pt, sections 14.3, chapters 20.7/24.8) while
# those labels are body size.
#
# Some documents mark headings by weight alone at body size. There this signal
# says nothing, so demotion only runs when the document demonstrably uses size
# for headings (see _SIZE_EVIDENCE_*).

# A line is "large" when its size exceeds the body size by this factor.
_LARGE_FACTOR = 1.15
# Demote only if at least this many headings, and this share of the headings
# the text layer could place at all, were confirmed large.
_SIZE_EVIDENCE_MIN = 3
_SIZE_EVIDENCE_SHARE = 0.3
# Keys shorter than this ("A", "1.2") match too much body text to be evidence.
_MIN_KEY = 4
# "Chapter 2", "Appendix A", "Bölüm 3": a label plus a number or a letter.
_BARE_LABEL = re.compile(r"^\S+\s+(?:\d+|[A-Z]|[IVXLC]+)$")


def _key(text: str) -> str:
    return "".join(_profile(text)[0])


def body_size(fragments: list[tuple[str, float]]) -> float:
    weight: dict[float, int] = {}
    for text, size in fragments:
        weight[size] = weight.get(size, 0) + len(text)
    return max(weight, key=weight.get) if weight else 0.0


class SizeIndex:
    """The text layer as one stream of casefolded alphanumerics, each with the
    size of the fragment it came from.

    A heading is judged by where its text *starts* in that stream. Two things
    measured on Trentelman ruled out comparing whole lines: a heading can be
    split into many fragments (`(`, `C`, `,`, `B`, `)`, `-pairs`), and pypdf
    reports the wrong size after a subscript — in `11.2 H2 optimal control`
    the fragment after the `2` comes back at body size although it is printed
    at 14.3 pt. The start of the heading is reported correctly.
    """

    def __init__(self, fragments: list[tuple[str, float]]):
        self.limit = body_size(fragments) * _LARGE_FACTOR
        chars: list[str] = []
        sizes: list[float] = []
        # Spaces are dropped from the stream, so without this "proof" would
        # also match inside a large-type "...approof...". A match must begin
        # where a word begins.
        self.word_starts: set[int] = set()
        for text, size in fragments:
            for word in text.split():
                self.word_starts.add(len(chars))
                for c in _key(word):
                    chars.append(c)
                    sizes.append(size)
        self.stream = "".join(chars)
        self.sizes = sizes

    def _verdict(self, key: str) -> str | None:
        found = None
        start = self.stream.find(key)
        while start != -1:
            if start not in self.word_starts:
                pass
            elif self.sizes[start] >= self.limit and self._ends_line(start + len(key)):
                return "large"
            else:
                found = "body"
            start = self.stream.find(key, start + 1)
        return found

    def _ends_line(self, end: int) -> bool:
        """The match covers the whole large line: `Proof :` must not count as
        large just because `14.4 Proof of theorem 14.1` is. Continuing in a
        different size is fine (`Chapter 2` at 20.7 pt, then the title at
        24.8), as is continuing at body size (pypdf's subscript bug above)."""
        if end >= len(self.stream):
            return True
        if end not in self.word_starts:
            return False
        return self.sizes[end] != self.sizes[end - 1] or self.sizes[end] < self.limit

    def classify(self, heading: str) -> str | None:
        """'large', 'body', or None when the text layer cannot place it.

        'large' if any occurrence starts in large type; 'body' if it occurs
        only in body type (the table of contents, running heads, and the
        run-in label itself all count here)."""
        keys = [_key(heading)]
        m = _SECTION_NUMBER.match(heading)
        if m and m.end() < len(heading):
            # The number can be a separate span, or missing on the page.
            keys.append(_key(heading[m.end() :]))
        verdicts = [self._verdict(k) for k in keys if len(k) >= _MIN_KEY]
        if "large" in verdicts:
            return "large"
        return "body" if "body" in verdicts else None


def restructure_headings(
    markdown: str, fragments: list[tuple[str, float]]
) -> tuple[str, dict[str, int]]:
    """Demotes body-size pseudo-headings to bold paragraphs and joins a bare
    `Chapter 2` heading with the title heading right after it.

    Returns (markdown, {"demoted", "merged", "large", "body"}).
    """
    stats = {"demoted": 0, "merged": 0, "large": 0, "body": 0}
    if not fragments:
        return markdown, stats
    index = SizeIndex(fragments)
    lines = markdown.split("\n")
    heads = _heading_indices(lines)
    verdict = {i: index.classify(_HEADING_LINE.match(lines[i]).group(2)) for i in heads}
    stats["large"] = sum(v == "large" for v in verdict.values())
    stats["body"] = sum(v == "body" for v in verdict.values())

    placed = stats["large"] + stats["body"]
    if stats["large"] >= _SIZE_EVIDENCE_MIN and stats["large"] >= _SIZE_EVIDENCE_SHARE * placed:
        for i in heads:
            if verdict[i] == "body":
                lines[i] = f"**{_HEADING_LINE.match(lines[i]).group(2)}**"
                stats["demoted"] += 1

    for a, b in zip(heads, heads[1:]):
        if lines[a] is None or verdict[a] != "large" or verdict[b] != "large":
            continue
        if any(l.strip() for l in lines[a + 1 : b]):
            continue
        ma, mb = _HEADING_LINE.match(lines[a]), _HEADING_LINE.match(lines[b])
        if not ma or not mb or not _BARE_LABEL.match(ma.group(2)):
            continue
        lines[a] = f"{ma.group(1)}{ma.group(2)} {mb.group(2)}"
        lines[b] = None  # type: ignore[call-overload]
        stats["merged"] += 1

    return "\n".join(l for l in lines if l is not None), stats


def read_text_layer(path: Path) -> tuple[list[str], list[tuple[str, float]]]:
    """(lines, (fragment, effective font size) pairs) from the PDF's text
    layer. Empty on failure: a missing reference only means no repair, never
    a failed conversion."""
    try:
        import math

        from pypdf import PdfReader

        lines: list[str] = []
        fragments: list[tuple[str, float]] = []

        def visit(text, cm, tm, _font, size):
            text = text.strip()
            if text and size:
                scale = math.hypot(tm[2], tm[3]) * math.hypot(cm[2], cm[3])
                fragments.append((text, round(size * scale, 1)))

        for page in PdfReader(str(path)).pages:
            lines.extend((page.extract_text(visitor_text=visit) or "").splitlines())
        return lines, fragments
    except Exception:  # noqa: BLE001 — optional enrichment
        return [], []
