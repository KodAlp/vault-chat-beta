# -*- coding: utf-8 -*-
"""Rebuild code-block layout on scanned pages from OCR line boxes (#8, option B).

Why: on scanned Turkish pages CodeFormula is off (it mangles diacritics), so a
code block comes out of docling as one run-together line with no indentation.
But the OCR engine already gives one box per code line; monospace code puts
every character on a fixed pitch, so column = round((left - x0) / pitch)
recovers indentation and line breaks. Measured 2026-10-13 (fonk1/dic1 scans):
character accuracy 0.93-0.96 and 47-52 correctly indented lines, against 0 for
the collapsed text. See docs/dev/arastirma-2026-10-13-propto-ve-taranmis-kod.md.

This module imports no docling at module level; only `rebuild_code_items`
touches docling objects (duck-typed, so it is unit-testable with stand-ins).
Assumes a monospace font. Only code regions that contain at least one OCR cell
are touched, so born-digital code (text layer only) is never re-laid-out.
"""
from __future__ import annotations

import statistics
import sys
from dataclasses import dataclass

MAX_BLANKS = 3
# Page text-layer cells drawn over a scan (handwriting-style notes) are not code.
OVERLAY_HEIGHT_RATIO = 1.6
OVERLAY_PITCH_TOLERANCE = 0.25


@dataclass
class Cell:
    """One OCR/text line box in TOPLEFT page coordinates."""

    text: str
    l: float
    t: float
    r: float
    b: float
    ocr: bool = True

    @property
    def h(self) -> float:
        return self.b - self.t

    @property
    def yc(self) -> float:
        return (self.t + self.b) / 2


def estimate_pitch(cells: list[Cell]) -> float | None:
    """Character pitch (width of one monospace column). Lines whose spaces the
    OCR dropped look wider, so take the median of the narrower 60%."""
    cells = [c for c in cells if c.ocr and c.text] or [c for c in cells if c.text]
    xs = [(c.r - c.l) / len(c.text) for c in cells if len(c.text) >= 10]
    if not xs:
        xs = [(c.r - c.l) / len(c.text) for c in cells if len(c.text) >= 4]
    if not xs:
        return None
    xs.sort()
    return statistics.median(xs[: max(1, int(len(xs) * 0.6))])


def split_overlay(cells: list[Cell], pitch: float) -> tuple[list[Cell], list[Cell]]:
    """(code, overlay). Overlay = non-OCR cells in a region that also has OCR
    cells (text layer over a scan), plus a geometric fallback: a box much taller
    than the median line, or whose character width is off the code pitch."""
    ocr_cells = [c for c in cells if c.ocr]
    base = ocr_cells or cells
    hs = statistics.median(c.h for c in base)
    code: list[Cell] = []
    overlay: list[Cell] = []
    for c in cells:
        n = len(c.text)
        dev = abs((c.r - c.l) / n - pitch) / pitch if n >= 5 else 0.0
        if (
            (ocr_cells and not c.ocr)
            or c.h > OVERLAY_HEIGHT_RATIO * hs
            or dev > OVERLAY_PITCH_TOLERANCE
            or (c.h > 1.3 * hs and dev > 0.08)
        ):
            overlay.append(c)
        else:
            code.append(c)
    return code, overlay


def build_rows(cells: list[Cell], pitch: float | None = None, x0: float | None = None):
    """-> (rows, overlay, pitch, x0); a row is {"y": float, "cells": [Cell]}."""
    cells = [c for c in cells if c.text.strip()]
    if not cells:
        return [], [], pitch or 6.0, 0.0
    pitch = pitch or estimate_pitch(cells) or 6.0
    code, overlay = split_overlay(cells, pitch)
    if not code:
        return [], overlay, pitch, 0.0
    ls = sorted(c.l for c in code)
    x0 = ls[max(0, int(len(ls) * 0.05))] if x0 is None else x0
    hs = statistics.median(c.h for c in code)
    code.sort(key=lambda c: (c.yc, c.l))
    rows: list[dict] = []
    for c in code:
        if rows and abs(c.yc - rows[-1]["y"]) < 0.6 * hs:
            rows[-1]["cells"].append(c)
            rows[-1]["y"] = statistics.mean(x.yc for x in rows[-1]["cells"])
        else:
            rows.append({"y": c.yc, "cells": [c]})
    for r in rows:
        r["cells"].sort(key=lambda c: c.l)
    return rows, overlay, pitch, x0


def render(rows: list[dict], pitch: float, x0: float) -> str:
    """Rows -> text: column from the box's left edge, blank lines from the
    vertical gap (in line heights, at most MAX_BLANKS)."""
    out: list[str] = []
    prev_y = None
    gaps = [rows[i + 1]["y"] - rows[i]["y"] for i in range(len(rows) - 1)]
    line_h = statistics.median(sorted(gaps)[: max(1, len(gaps) // 2)]) if gaps else 12.0
    # When most gaps contain blank lines the estimate above is inflated; a real
    # line step is never much more than ~1.8x the glyph-box height.
    heights = [c.h for r in rows for c in r["cells"]]
    if heights:
        line_h = min(line_h, 1.8 * statistics.median(heights))
    for r in rows:
        y, cs = r["y"], r["cells"]
        if prev_y is not None and line_h > 0:
            blanks = int(round((y - prev_y) / line_h)) - 1
            out.extend([""] * max(0, min(blanks, MAX_BLANKS)))
        line = ""
        for c in cs:
            col = max(0, int(round((c.l - x0) / pitch)))
            if line and col <= len(line):
                col = len(line) + (1 if not line.endswith(" ") and not c.text.startswith(" ") else 0)
            line = line.ljust(col) + c.text
        out.append(line.rstrip())
        prev_y = y
    return "\n".join(out)


def rebuild_text(cells: list[Cell]) -> tuple[str, list[str]] | None:
    """(code text, overlay texts) for the cells of one code region, or None
    when there is nothing to rebuild (no OCR cell, no usable code cell)."""
    if not any(c.ocr and c.text.strip() for c in cells):
        return None
    rows, overlay, pitch, x0 = build_rows(cells)
    if not rows:
        return None
    notes = [c.text for c in sorted(overlay, key=lambda c: (c.t, c.l)) if c.text.strip()]
    return render(rows, pitch, x0), notes


def _cell_box(cell):
    """TOPLEFT (l, t, r, b) of a docling TextCell, or None."""
    try:
        bb = cell.rect.to_bounding_box()
        if getattr(bb.coord_origin, "name", "") == "BOTTOMLEFT":
            return None  # page height unknown here; docling gives TOPLEFT
        return bb.l, bb.t, bb.r, bb.b
    except Exception:  # noqa: BLE001
        return None


def item_box_topleft(bbox, page_height: float):
    """Item bbox (docling_core BoundingBox, usually BOTTOMLEFT) -> TOPLEFT (l, t, r, b)."""
    if getattr(bbox.coord_origin, "name", "") == "BOTTOMLEFT":
        bbox = bbox.to_top_left_origin(page_height)
    return bbox.l, bbox.t, bbox.r, bbox.b


def cells_in_box(page_cells, box, margin: float = 2.0) -> list[Cell]:
    """Page cells whose centre lies inside `box` (TOPLEFT)."""
    l, t, r, b = box
    out: list[Cell] = []
    for pc in page_cells:
        text = getattr(pc, "text", "") or ""
        cb = _cell_box(pc)
        if not text.strip() or cb is None:
            continue
        xc, yc = (cb[0] + cb[2]) / 2, (cb[1] + cb[3]) / 2
        if l - margin <= xc <= r + margin and t - margin <= yc <= b + margin:
            out.append(Cell(text, cb[0], cb[1], cb[2], cb[3], ocr=bool(getattr(pc, "from_ocr", True))))
    return out


def rebuild_code_items(document, pages) -> int:
    """Replace the text of every CodeItem whose region holds OCR cells with the
    layout rebuilt from those cells; overlay text goes into a paragraph after
    the block. `pages` = ConversionResult.pages (needs generate_parsed_pages).
    Returns the number of rebuilt items. A bad item keeps its old text."""
    from docling_core.types.doc import DocItemLabel
    from docling_core.types.doc.document import CodeItem

    by_no = {}
    for p in pages or []:
        cells = getattr(p, "cells", None) or []
        if cells:
            by_no[getattr(p, "page_no", None)] = p
    done = 0
    for item, _level in list(document.iterate_items()):
        if not isinstance(item, CodeItem) or not item.prov:
            continue
        try:
            prov = item.prov[0]
            page = by_no.get(prov.page_no)
            if page is None:
                continue
            box = item_box_topleft(prov.bbox, float(page.size.height))
            res = rebuild_text(cells_in_box(page.cells, box))
            if res is None:
                continue
            text, notes = res
            if not text.strip():
                continue
            item.text = text
            item.orig = text
            done += 1
            if notes:
                document.insert_text(item, DocItemLabel.TEXT, " ".join(notes), after=True)
        except Exception as err:  # noqa: BLE001 — keep the old text for this item
            print(f"code_layout: kod bloğu atlandı: {err}", file=sys.stderr)
    return done
