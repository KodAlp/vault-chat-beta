# -*- coding: utf-8 -*-
"""Tests for heading_repair.py.

    python ingest/heading_repair_test.py

Fixtures are taken verbatim from docling's output for Trentelman's control
theory book and from pypdf's text layer for the same pages.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from heading_repair import repair_headings, restructure_headings  # noqa: E402

REFERENCE = [
    "10 Introduction",
    "1.7 Example: regulation of the satellite’s position",
    "In the previous section we discussed the problem of making the geostationary orbit",
    "1.1 Control system design and mathematical control",
    "theory",
    "Linear control systems",
    "Example: linearization around the geostationary orbit 7",
]

failures = 0


def check(name: str, got, want) -> None:
    global failures
    if got != want:
        failures += 1
        print(f"FAIL {name}\n  got:  {got!r}\n  want: {want!r}")
    else:
        print(f"ok   {name}")


def repaired(heading: str, reference=REFERENCE) -> str:
    return repair_headings(heading, reference)[0]


check("fully glued", repaired("## 1.3 Linearcontrolsystems"), "## 1.3 Linear control systems")
check(
    "punctuation kept, space after colon restored",
    repaired("## 1.7 Example:regulationofthesatellite’sposition"),
    "## 1.7 Example: regulation of the satellite’s position",
)
check(
    "partly glued heading wrapped over two text-layer lines",
    repaired("## 1.1 Control systemdesign andmathematical control theory"),
    "## 1.1 Control system design and mathematical control theory",
)
check("already correct is untouched", repaired("## Linear control systems"), "## Linear control systems")
check(
    "no exact letter match -> untouched (never guesses)",
    repaired("## 1.4 Linearcontrolsystem"),
    "## 1.4 Linearcontrolsystem",
)
check(
    "a space the text layer does not have blocks the repair",
    repaired("## Linearcon trolsystems"),
    "## Linearcon trolsystems",
)
check(
    "conflicting spacings in the text layer -> untouched",
    repaired("## Linearcontrolsystems", ["Linear control systems", "Linearcontrol systems x", "Linear controlsystems"]),
    "## Linearcontrolsystems",
)
check(
    "body text is never touched",
    repaired("Linearcontrolsystems in prose\n## Linearcontrolsystems"),
    "Linearcontrolsystems in prose\n## Linear control systems",
)
check("count", repair_headings("## Linearcontrolsystems\n## Linear control systems", REFERENCE)[1], 1)
check("empty reference is a no-op", repaired("## Linearcontrolsystems", []), "## Linearcontrolsystems")

# --- restructure_headings -------------------------------------------------
# (fragment, size) pairs in the shape pypdf's visitor yields for Trentelman:
# body 10.0 pt, sections 14.3, chapter label 20.7, chapter title 24.8.

BODY = "In this section we introduce the notion of a linear map and study it. " * 20
FRAGMENTS = [
    ("Contents", 24.8),
    ("2.5 Eigenvalues . . . . 21", 10.0),
    ("11.2", 10.0), ("H", 10.0), ("2 optimal control by state feedback . . . 240", 7.6),
    ("Chapter 2", 20.7),
    ("Mathematical preliminaries", 24.8),
    (BODY, 10.0),
    ("2.5 Eigenvalues", 14.3),
    (BODY, 10.0),
    ("Theorem 2.19", 10.0),
    ("Let A be a matrix.", 10.0),
    ("Proof :", 10.0),
    (BODY, 10.0),
    ("14.4 Proof of theorem 14.1", 14.3),
    (BODY, 10.0),
    # pypdf's subscript bug: after the small "2" the rest comes back at body size.
    ("11.2", 14.3), ("H", 14.3), ("2 optimal control by state feedback", 10.0),
    (BODY, 10.0),
    ("3.12 Let V be a subspace.", 10.0),
]

DOC = """## Chapter 2

## Mathematical preliminaries

## 2.5 Eigenvalues

## Theorem 2.19

Let A be a matrix.

## Proof :

## 14.4 Proof of theorem 14.1

## 11.2 H2 optimal control by state feedback

## 3.12 Let

## Not in the text layer at all

```python
# Theorem 2.19
```"""

out, stats = restructure_headings(DOC, FRAGMENTS)
check("bare chapter label merged with its title", "## Chapter 2 Mathematical preliminaries" in out, True)
check("large section heading kept", "## 2.5 Eigenvalues" in out, True)
check("body-size label demoted to bold", "**Theorem 2.19**" in out and "## Theorem 2.19" not in out, True)
check("prefix of a large heading is not large", "**Proof :**" in out, True)
check("the large heading itself kept", "## 14.4 Proof of theorem 14.1" in out, True)
check("subscript size bug does not demote", "## 11.2 H2 optimal control by state feedback" in out, True)
check("run-in exercise item demoted", "**3.12 Let**" in out, True)
check("unplaceable heading left alone", "## Not in the text layer at all" in out, True)
check("code comment untouched", "# Theorem 2.19\n```" in out, True)
check("stats", (stats["demoted"], stats["merged"]), (3, 1))

# A document whose headings are body-size bold gives no size evidence: nothing
# may be demoted, whatever the text layer says.
flat = [("Introduction", 10.0), (BODY, 10.0), ("Method", 10.0), (BODY, 10.0)]
check(
    "no demotion without size evidence",
    restructure_headings("## Introduction\n\n## Method", flat)[0],
    "## Introduction\n\n## Method",
)
check("empty text layer is a no-op", restructure_headings(DOC, [])[0], DOC)

sys.exit(1 if failures else 0)
