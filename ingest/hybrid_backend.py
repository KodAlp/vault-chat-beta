"""Fallback PDF backend for docling: docling-parse text with rendering OFF,
page images drawn by pypdfium2.

Why this exists. docling's default backend (ThreadedDoclingParseDocumentBackend,
docling-parse 7.21) has two Windows bugs that make it unusable on some machines:

- docling-parse#357: the render worker threads corrupt the heap while they shut
  down (thread_local Blend2D canvas pool / CMYK memo destroyed after MinGW's
  emutls already freed their storage), so the process dies natively with
  0xC0000374. Common on PDFs with CMYK images.
- docling-parse#354: when the user's profile path contains non-ASCII characters
  (e.g. a user name with a cedilla), the renderer fails at open with
  `RuntimeError: filesystem error: Cannot convert character sequence`. docling
  swallows the cause and raises `ConversionError: ... An unexpected error
  occurred while opening the document ...`; on such a machine NO PDF converts.

What it changes. docling-parse still extracts the text (render_pages=False, so
the crashing/failing render code never runs); the page images the layout model
needs are rendered with pypdfium2, exactly like docling's own PyPdfium backend.

Measured cost (RTX 4050): 32 PDFs, 0 crashes, works under a non-ASCII profile
path. But quality regresses on image/formula-heavy documents: word recall on
one image-rich book fell from 96.5% to 82.5%, and a long MIT text took 356 s
instead of 163 s. Hence this is a FALLBACK only: convert.py uses it when asked
(`--pdf-backend hybrid`), when the default backend reports an open failure
(#354), and for the second attempt after a native crash (convertQueue.ts).

Maintenance. This subclasses docling INTERNAL classes (backend options, page
backend, `_iterating`, `parser`). docling is pinned (docling==2.130.0 in
ingest/requirements-optional.txt); re-verify this module whenever that pin
changes. docling is an optional extra, so convert.py imports this module only
inside convert_with_docling, never at module load.
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from typing import Iterator, Optional, Union

import pypdfium2 as pdfium
from docling.backend.docling_parse_backend import ThreadedDoclingParseDocumentBackend, ThreadedDoclingParsePageBackend
from docling.datamodel.backend_options import PdfBackendOptions, ThreadedDoclingParseBackendOptions
from docling.utils.locks import pypdfium2_lock
from docling_core.types.doc import BoundingBox, CoordOrigin
from PIL import Image


class _HybridPage(ThreadedDoclingParsePageBackend):
    def __init__(self, result, pdf: pdfium.PdfDocument):
        super().__init__(result, rendered=False)
        self._pdf = pdf

    def get_page_image(self, scale: float = 1, cropbox: Optional[BoundingBox] = None) -> Image.Image:
        size = self.get_size()
        if not cropbox:
            cropbox = BoundingBox(l=0, r=size.width, t=0, b=size.height, coord_origin=CoordOrigin.TOPLEFT)
            padbox = BoundingBox(l=0, r=0, t=0, b=0, coord_origin=CoordOrigin.BOTTOMLEFT)
        else:
            padbox = cropbox.to_bottom_left_origin(size.height).model_copy()
            padbox.r = size.width - padbox.r
            padbox.t = size.height - padbox.t
        with pypdfium2_lock:
            page = self._pdf[self.page_no - 1]
            try:
                bitmap = page.render(scale=scale * 1.5, rotation=0, crop=padbox.as_tuple())
                image = bitmap.to_pil().copy()
                bitmap.close()
            finally:
                page.close()
        return image.resize(size=(round(cropbox.width * scale), round(cropbox.height * scale))).convert("RGB")


class HybridDoclingParseBackend(ThreadedDoclingParseDocumentBackend):
    def __init__(self, in_doc, path_or_stream: Union[BytesIO, Path], options: Optional[PdfBackendOptions] = None):
        base = options if isinstance(options, ThreadedDoclingParseBackendOptions) else ThreadedDoclingParseBackendOptions(
            **(options.model_dump() if options is not None else {})
        )
        no_render = base.model_copy(update={"render_pages": False})
        no_render._materialize_char_cells = getattr(base, "_materialize_char_cells", False)
        super().__init__(in_doc, path_or_stream, no_render)
        with pypdfium2_lock:
            if isinstance(path_or_stream, BytesIO):
                path_or_stream.seek(0)
                self._pdf = pdfium.PdfDocument(path_or_stream.getvalue())
            else:
                self._pdf = pdfium.PdfDocument(str(path_or_stream))

    def iter_pages(self) -> Iterator[ThreadedDoclingParsePageBackend]:
        self._iterating = True
        for result in self.parser.iterate_results():
            yield _HybridPage(result, self._pdf)
        self._iterating = False

    def unload(self) -> None:
        super().unload()
        with pypdfium2_lock:
            if getattr(self, "_pdf", None) is not None:
                self._pdf.close()
                self._pdf = None
