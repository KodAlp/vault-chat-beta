"""Images survive conversion (2026-10-07).

Before this module a converted note lost every picture: docling left bare
`<!-- image -->` placeholders, MarkItDown ignored PDF images, and for PPTX it
wrote `![alt](ShapeName.jpg)` links to files that were never extracted (and an
alt text that was mostly Office's auto-generated description). A
screenshot-heavy lecture (118 images) lost nearly all of its information.

Pipeline, shared by every source:

1. The converter hands over each picture as a *candidate* (raw bytes, page or
   slide number, author alt text / caption) and leaves a unique token
   `<!-- vc:img N -->` in the Markdown where the picture was. The token is
   keyed by the picture itself, so the mapping cannot drift:
   - docling: a picture serializer (see convert.py) emits the token for the
     exact PictureItem it is serializing.
   - PPTX/DOCX: MarkItDown is run with keep_data_uris=True, so each picture
     arrives as `![alt](data:...;base64,...)` at its own position; those are
     swapped for tokens (tokenize_data_uri_images). Mirroring MarkItDown's
     shape traversal and its `ShapeName.jpg` filename rule instead would have
     to be kept in sync by hand with a third-party package.
2. After postprocess, resolve_tokens() re-encodes, filters and writes the
   images and swaps each token for the final block.

Final note format, one block per kept image (a contract: a future VLM pass
finds images through the comment marker and inserts/replaces the description
line right under it):

    ![<alt>](images/<sha16>.<ext>)
    <!-- vc:gorsel <sha16> -->
    *Görsel:* <author alt text>        <- only when trustworthy text exists

`sha16` is the first 16 hex chars of the sha256 of the re-encoded bytes that
were written, so a file name is content-addressed (same picture, same name,
across documents). The Node side moves `images/<file>` into the vault's
`_meta/attachments/` and rewrites the link (src/lib/server/converted-images.ts).
No description is ever invented here: Office's auto-generated alt text is
dropped, and a docling caption is already printed as a paragraph next to the
picture, so it only becomes the (short) alt.
"""
from __future__ import annotations

import hashlib
import io
import math
import re
import warnings
from dataclasses import dataclass, field
from pathlib import Path

MIN_SIDE_PX = 48
MIN_BYTES = 2048
# Inline equations (Word OMML/MathType exported as PNG, or WMF/EMF converted)
# are short but wide, e.g. 300x30 px, and often under 2 KB. 48 px was chosen to
# drop bullets, logos and spacer gifs, which are small in BOTH directions. A
# landscape strip with a real height and a clearly wide aspect is a formula
# line, not decoration, so it is exempt from the min-side and min-bytes rules.
EQ_MIN_HEIGHT_PX = 12
EQ_MIN_WIDTH_PX = 96
EQ_MIN_ASPECT = 3.0
# Pictures identical on this many distinct pages/slides are template art
# (university logo, page ornament) -- but only when they are small on the
# page. Measured on a real lecture (Gradyan pptx): it is an animation exported
# as stacked full-slide frames, the same frame repeats on up to 13 slides, and
# every one of them is content. Repetition alone would have dropped 89 of its
# 118 pictures; a logo is small, a frame covers the slide.
#
# Also required: the picture sits on a sizeable share of the document's pages.
# Measured on slides.01.pptx (Ayrik Sistemler): three small network diagrams
# each repeat on 5 of ~50 slides and are the lecture's own figures, while a
# logo is on (nearly) every slide.
TEMPLATE_MIN_PAGES = 3
TEMPLATE_MIN_PAGE_SHARE = 0.3
TEMPLATE_MAX_AREA = 0.25  # fraction of the page area; unknown area never counts as template
MAX_KEPT = 400
# Decoded-pixel ceiling. PIL warns above it and raises above twice of it;
# both are treated as "skip this image".
MAX_PIXELS = 40_000_000
ALT_MAX_CHARS = 160

TOKEN_RE = re.compile(r"<!-- vc:img (\d+) -->")
_DATA_URI_IMG = re.compile(r"!\[(?P<alt>[^\]]*)\]\(data:(?P<mime>[^;,)\s]+);base64,(?P<b64>[A-Za-z0-9+/=\s]+)\)")
_SLIDE_MARK = re.compile(r"<!-- Slide number: (\d+) -->")

# Office writes this into the alt text of a picture on its own ("AI-generated
# content may be incorrect." / the Turkish equivalent). Matched by the suffix
# phrase only: a sentence that merely starts with "a picture containing" is
# not enough to call it auto-generated.
_AUTO_ALT_SUFFIXES = (
    "yapay zeka tarafından oluşturulan içerik yanlış olabilir",
    "ai-generated content may be incorrect",
)
# Alt text MarkItDown falls back to when a picture has no description: the
# shape's own name ("Picture 3", "Resim 12", "Content Placeholder 4"). Only
# well-known prefixes + a number, nothing a person would write on purpose.
_SHAPE_NAME_ALT = re.compile(
    r"^(picture|resim|image|görsel|graphic|grafik|content placeholder|içerik yer tutucusu|"
    r"object|nesne|shape|şekil|screenshot|ekran görüntüsü|google shape|"
    r"picture placeholder|resim yer tutucusu)[\s_-]*\d*$|"
    r"^[\w.-]+\.(png|jpe?g|gif|bmp|emf|wmf|tiff?)$",
    re.IGNORECASE,
)


def is_auto_alt(text: str) -> bool:
    """True for alt text no human wrote: Office's auto description, or a shape
    name MarkItDown used because the description was empty."""
    t = re.sub(r"\s+", " ", text or "").strip().lower().rstrip(".")
    if not t:
        return True
    if any(t.endswith(s) for s in _AUTO_ALT_SUFFIXES):
        return True
    return bool(_SHAPE_NAME_ALT.match(t))


def clean_alt(text: str) -> str:
    """Author-written alt text, flattened to one line and safe inside
    `![...]`; empty when it is auto-generated."""
    t = re.sub(r"[\r\n\[\]]", " ", text or "")
    t = re.sub(r"\s+", " ", t).strip()
    if is_auto_alt(t):
        return ""
    if len(t) > ALT_MAX_CHARS:
        cut = t[:ALT_MAX_CHARS].rsplit(" ", 1)[0].rstrip(",;:.")
        t = (cut or t[:ALT_MAX_CHARS]) + "…"
    return t


@dataclass
class Candidate:
    data: bytes
    page: int | None  # slide / page number; None when the format has none
    alt: str  # author alt text or caption, uncleaned
    # Fraction of the page/slide the picture covers (0..1), None if unknown.
    area_frac: float | None = None
    # Whether `alt` is also printed elsewhere in the note (docling captions
    # are paragraphs of their own), so no `*Görsel:*` line is repeated.
    alt_in_text: bool = False


@dataclass
class Collector:
    enabled: bool = False
    candidates: list[Candidate] = field(default_factory=list)
    # Pages/slides in the converted document; None = unknown, then no picture
    # is ever treated as template art.
    total_pages: int | None = None

    def reset(self, enabled: bool) -> None:
        self.enabled = enabled
        self.candidates = []
        self.total_pages = None

    def add(self, cand: Candidate) -> str:
        self.candidates.append(cand)
        return f"<!-- vc:img {len(self.candidates) - 1} -->"


COLLECTOR = Collector()


def tokenize_data_uri_images(md: str, collector: Collector = COLLECTOR) -> str:
    """Swap every `![alt](data:...;base64,...)` for a token and keep the
    decoded bytes as a candidate. The page is the last
    `<!-- Slide number: N -->` marker seen (PPTX); None otherwise."""
    import base64

    out: list[str] = []
    pos = 0
    page: int | None = None
    # One pass over both patterns in document order.
    events = sorted(
        [(m.start(), "slide", m) for m in _SLIDE_MARK.finditer(md)]
        + [(m.start(), "img", m) for m in _DATA_URI_IMG.finditer(md)],
        key=lambda e: e[0],
    )
    for start, kind, m in events:
        if kind == "slide":
            page = int(m.group(1))
            continue
        out.append(md[pos:start])
        try:
            data = base64.b64decode(re.sub(r"\s+", "", m.group("b64")), validate=True)
        except Exception:  # noqa: BLE001 — undecodable payload: drop the picture
            data = b""
        # An empty payload still gets a token, so it is counted as unreadable
        # instead of silently vanishing.
        out.append(collector.add(Candidate(data=data, page=page, alt=m.group("alt"))))
        pos = m.end()
    out.append(md[pos:])
    return "".join(out)


def pptx_picture_areas(path) -> tuple[dict[str, float], int]:
    """(sha1(original blob) -> largest fraction of a slide that picture covers,
    slide count), from python-pptx. Keyed by content, not by position: MarkItDown's own
    traversal order never has to be mirrored. Pictures in group shapes count
    (their size is in the group's child coordinates, so it is an
    approximation, good enough for a small-vs-large decision)."""
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    prs = Presentation(str(path))
    total = (prs.slide_width or 0) * (prs.slide_height or 0)
    areas: dict[str, float] = {}
    if total <= 0:
        return areas, len(prs.slides)

    def walk(shapes) -> None:
        for shape in shapes:
            try:
                if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
                    walk(shape.shapes)
                elif hasattr(shape, "image") and shape.shape_type in (MSO_SHAPE_TYPE.PICTURE, MSO_SHAPE_TYPE.PLACEHOLDER):
                    frac = min(1.0, ((shape.width or 0) * (shape.height or 0)) / total)
                    key = hashlib.sha1(shape.image.blob).hexdigest()
                    areas[key] = max(areas.get(key, 0.0), frac)
            except Exception:  # noqa: BLE001 — one odd shape must not lose the rest
                continue

    for slide in prs.slides:
        walk(slide.shapes)
    return areas, len(prs.slides)


def apply_pptx_areas(candidates: list[Candidate], areas: dict[str, float]) -> None:
    for cand in candidates:
        cand.area_frac = areas.get(hashlib.sha1(cand.data).hexdigest())


class SkipImage(Exception):
    """An image that is not kept; `.reason` names the filter."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def is_equation_like(width: int, height: int) -> bool:
    """Short-but-wide strip (inline equation image), exempt from the tiny filter."""
    return (
        height >= EQ_MIN_HEIGHT_PX
        and width >= EQ_MIN_WIDTH_PX
        and width >= EQ_MIN_ASPECT * height
    )


def reencode(data: bytes) -> tuple[bytes, str]:
    """Decode through PIL and write a clean copy: JPEG stays JPEG (quality
    90), everything else becomes PNG, all metadata (EXIF, ICC, XMP, text
    chunks) is dropped. Returns (bytes, ext). Raises SkipImage('unreadable' |
    'tiny'). Never trusts the source format: a file that is not a valid image
    never reaches the vault."""
    from PIL import Image, ImageOps

    if not data:
        raise SkipImage("unreadable")
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with warnings.catch_warnings():
            # DecompressionBombWarning (> MAX_PIXELS) must skip, not just log.
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            img = Image.open(io.BytesIO(data))
            fmt = (img.format or "").upper()
            img.load()
    except Exception:  # noqa: BLE001 — truncated, bomb, unsupported (EMF off Windows), ...
        raise SkipImage("unreadable")
    if not is_equation_like(img.width, img.height) and (
        img.width < MIN_SIDE_PX or img.height < MIN_SIDE_PX or len(data) < MIN_BYTES
    ):
        raise SkipImage("tiny")
    try:
        if fmt == "JPEG":
            img = ImageOps.exif_transpose(img)  # orientation lives in the EXIF we strip
        out = io.BytesIO()
        if fmt == "JPEG":
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")  # CMYK, YCbCr, ...
            img.save(out, "JPEG", quality=90, optimize=True)
            return out.getvalue(), "jpg"
        has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
        if img.mode == "P":
            img = img.convert("RGBA" if has_alpha else "RGB")
        elif img.mode == "LA":
            img = img.convert("RGBA")
        elif img.mode not in ("RGB", "RGBA", "L"):
            img = img.convert("RGBA" if has_alpha else "RGB")  # CMYK, I;16, 1, ...
        img.save(out, "PNG", optimize=True)
        return out.getvalue(), "png"
    except Exception:  # noqa: BLE001
        raise SkipImage("unreadable")


def sha16(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


@dataclass
class Decision:
    kind: str  # kept | tiny | unreadable | template | over_cap
    sha: str = ""
    ext: str = ""
    blob: bytes = b""


def select(
    candidates: list[Candidate], *, max_kept: int = MAX_KEPT, total_pages: int | None = None
) -> list[Decision]:
    """One Decision per candidate, in order. Filters, in this order: decode
    (unreadable), size (tiny), template (same bytes, small on the page, on
    >= TEMPLATE_MIN_PAGES distinct pages AND >= TEMPLATE_MIN_PAGE_SHARE of
    all pages), cap. The same picture on 1-2 pages is content and keeps a
    reference at each place (one file on disk)."""
    decisions: list[Decision] = []
    pages_by_sha: dict[str, set[int]] = {}
    area_by_sha: dict[str, float] = {}
    for cand in candidates:
        try:
            blob, ext = reencode(cand.data)
        except SkipImage as skip:
            decisions.append(Decision(skip.reason))
            continue
        digest = sha16(blob)
        decisions.append(Decision("kept", digest, ext, blob))
        if cand.page is not None:
            pages_by_sha.setdefault(digest, set()).add(cand.page)
        area = 1.0 if cand.area_frac is None else cand.area_frac
        area_by_sha[digest] = max(area_by_sha.get(digest, 0.0), area)
    need_pages = max(TEMPLATE_MIN_PAGES, math.ceil((total_pages or 0) * TEMPLATE_MIN_PAGE_SHARE))
    templates = (
        {
            d
            for d, pages in pages_by_sha.items()
            if len(pages) >= need_pages and area_by_sha.get(d, 1.0) <= TEMPLATE_MAX_AREA
        }
        if total_pages
        else set()
    )
    kept = 0
    for dec in decisions:
        if dec.kind != "kept":
            continue
        if dec.sha in templates:
            dec.kind, dec.blob = "template", b""
        elif kept >= max_kept:
            dec.kind, dec.blob = "over_cap", b""
        else:
            kept += 1
    return decisions


def format_block(sha: str, ext: str, alt: str, desc: str, prefix: str = "images/") -> str:
    """The note format documented in the module docstring."""
    lines = [f"![{alt}]({prefix}{sha}.{ext})", f"<!-- vc:gorsel {sha} -->"]
    if desc:
        lines.append(f"*Görsel:* {desc}")
    return "\n".join(lines)


def resolve_tokens(
    md: str,
    candidates: list[Candidate],
    images_dir: Path,
    *,
    max_kept: int = MAX_KEPT,
    total_pages: int | None = None,
) -> tuple[str, dict, list[str]]:
    """Replace every token in `md`; write the kept images into `images_dir`.
    Returns (markdown, stats, written file names)."""
    decisions = select(candidates, max_kept=max_kept, total_pages=total_pages)
    stats = {"found": len(candidates), "kept": 0, "tiny": 0, "unreadable": 0, "template": 0, "over_cap": 0}
    names: list[str] = []
    for dec in decisions:
        if dec.kind == "kept":
            stats["kept"] += 1
        else:
            stats[dec.kind] += 1

    def block(m: re.Match) -> str:
        idx = int(m.group(1))
        if idx >= len(candidates):
            return ""
        cand, dec = candidates[idx], decisions[idx]
        alt = clean_alt(cand.alt)
        if dec.kind == "kept":
            name = f"{dec.sha}.{dec.ext}"
            if name not in names:
                images_dir.mkdir(parents=True, exist_ok=True)
                (images_dir / name).write_bytes(dec.blob)
                names.append(name)
            desc = "" if cand.alt_in_text else alt
            # A picture in the middle of a sentence (DOCX inline figures)
            # must not split the sentence over three lines: marker on the
            # same line, no description line.
            at, end = m.start(), m.end()
            inline = (at > 0 and md[at - 1] != "\n") or (end < len(md) and md[end] != "\n")
            if inline:
                return format_block(dec.sha, dec.ext, alt, "").replace("\n", " ")
            return format_block(dec.sha, dec.ext, alt, desc)
        # A picture we could not keep still carried the author's words (not
        # for a logo/tiny icon, whose alt is noise).
        if dec.kind in ("unreadable", "over_cap") and alt and not cand.alt_in_text:
            return f"*Görsel:* {alt}"
        return ""

    md = TOKEN_RE.sub(block, md)
    # A dropped picture leaves an empty line pair behind.
    md = re.sub(r"\n{3,}", "\n\n", md)
    stats["distinctFiles"] = len(names)
    return md, stats, names


def _short_caption(caption: str) -> str:
    """docling captions are whole paragraphs ("Figure 7: When the leader at
    the top comes to power, ..."); as alt text keep the first sentence."""
    t = re.sub(r"\s+", " ", caption or "").strip()
    m = re.match(r"(.{20,}?[.!?])(\s|$)", t)
    return m.group(1) if m else t


def docling_markdown_with_tokens(doc, collector: Collector = COLLECTOR) -> str:
    """Same Markdown as `doc.export_to_markdown()` except each picture is a
    unique `<!-- vc:img N -->` token with its crop registered as a candidate.

    A custom picture serializer sees the very PictureItem it is writing, so the
    token and the image can never drift apart. The previous options were
    worse: a bare `<!-- image -->` carries no identity, and walking
    doc.pictures separately assumes its order equals the serialized order,
    which column_order.repair_document_order may have changed. The
    MarkdownParams below repeat export_to_markdown's own defaults on purpose
    (test: images_test.py compares the two outputs on a real document)."""
    from docling_core.transforms.serializer.common import create_ser_result
    from docling_core.transforms.serializer.markdown import (
        MarkdownDocSerializer,
        MarkdownParams,
        MarkdownPictureSerializer,
    )
    from docling_core.types.doc import CaptionPlacement, ImageRefMode
    from docling_core.types.doc.common.content_layer import DEFAULT_CONTENT_LAYERS
    from docling_core.types.doc.document import DOCUMENT_TOKENS_EXPORT_LABELS

    placeholder = "<!-- image -->"

    class _TokenPictureSerializer(MarkdownPictureSerializer):
        def _serialize_image_part(self, item, doc, image_mode, image_placeholder, **kwargs):
            try:
                pil = item.get_image(doc=doc)
            except Exception:  # noqa: BLE001 — no crop available: keep docling's own placeholder
                pil = None
            if pil is None:
                return create_ser_result(text=image_placeholder, span_source=item)
            buf = io.BytesIO()
            pil.save(buf, "PNG")
            prov = getattr(item, "prov", None) or []
            page = prov[0].page_no if prov else None
            try:
                caption = item.caption_text(doc)
            except Exception:  # noqa: BLE001
                caption = ""
            area = None
            try:
                bbox, size = prov[0].bbox, doc.pages[page].size
                area = min(1.0, abs((bbox.r - bbox.l) * (bbox.t - bbox.b)) / (size.width * size.height))
            except Exception:  # noqa: BLE001 — unknown area: never treated as template art
                pass
            token = collector.add(
                Candidate(
                    data=buf.getvalue(),
                    page=page,
                    alt=_short_caption(caption),
                    alt_in_text=bool(caption),
                    area_frac=area,
                )
            )
            return create_ser_result(text=token, span_source=item)

    serializer = MarkdownDocSerializer(
        doc=doc,
        picture_serializer=_TokenPictureSerializer(),
        params=MarkdownParams(
            labels=DOCUMENT_TOKENS_EXPORT_LABELS,
            layers=DEFAULT_CONTENT_LAYERS,
            pages=None,
            start_idx=0,
            stop_idx=2**63 - 1,
            escape_html=True,
            escape_underscores=True,
            image_placeholder=placeholder,
            enable_chart_tables=True,
            image_mode=ImageRefMode.PLACEHOLDER,
            indent=4,
            wrap_width=None,
            page_break_placeholder=None,
            mark_meta=False,
            include_annotations=True,
            allowed_meta_names=None,
            blocked_meta_names=set(),
            mark_annotations=False,
            compact_tables=False,
            traverse_pictures=False,
            include_picture_classification=True,
            caption_placement=CaptionPlacement.STANDARD,
        ),
    )
    return serializer.serialize().text
