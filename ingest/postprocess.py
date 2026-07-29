"""Shared post-processing applied to every converter's output before it's
handed back to the Node caller. Kept independent of any one converter so
MarkItDown today and Marker/Docling later (see requirements.txt) all go
through the exact same normalization step.
"""
import re
from datetime import date

_MATH_BLOCK = re.compile(r"\\\[(.*?)\\\]", re.DOTALL)
_MATH_INLINE = re.compile(r"\\\((.*?)\\\)", re.DOTALL)
_HTML_TAG = re.compile(r"</?[a-zA-Z][^>]{0,200}>")
_BLANK_RUN = re.compile(r"\n{3,}")
_HEADING = re.compile(r"^(#{1,6})\s+(.*)$", re.MULTILINE)


def normalize_math_delimiters(text: str) -> str:
    """Marker/Docling may emit \\( \\) / \\[ \\] — normalize to $ / $$ so the
    app's renderer (which only special-cases $/$$) handles it uniformly."""
    text = _MATH_BLOCK.sub(lambda m: f"$$ {m.group(1).strip()} $$", text)
    text = _MATH_INLINE.sub(lambda m: f"${m.group(1).strip()}$", text)
    return text


def strip_html_remnants(text: str) -> str:
    return _HTML_TAG.sub("", text)


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


def derive_title(text: str, fallback: str) -> str:
    m = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    return m.group(1).strip() if m else fallback


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
    text = strip_html_remnants(text)
    text = fix_heading_jumps(text)
    text = collapse_blank_lines(text).strip() + "\n"
    title = derive_title(text, title_fallback)
    frontmatter = build_frontmatter(title, converted_by, needs_review)
    return text, frontmatter
