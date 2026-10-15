"""Lets `python -m pytest ingest` run every *_test.py in one command.

Most of these files are scripts, not pytest modules: they run their checks at
import time and end with `sys.exit(...)`, which aborts pytest's collection.
Each file is therefore run the way it is run by hand — `python <file>` in its
own process, from this directory — and its exit code is the result. Files that
are real pytest modules call `pytest.main` under `__main__`, so they work the
same way: inside that child process this hook stands down (CHILD_ENV), so the
file's own `pytest.main([__file__])` collects it normally instead of spawning
itself again.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
CHILD_ENV = "VC_INGEST_TEST_CHILD"
# Longest file (convert_test.py) takes about a minute; this only stops a hang.
TIMEOUT_S = 900


def pytest_collect_file(parent: pytest.Collector, file_path: Path):
    if os.environ.get(CHILD_ENV):
        return None
    if file_path.name.endswith("_test.py") and file_path.parent == HERE:
        return ScriptFile.from_parent(parent, path=file_path)
    return None


class ScriptFile(pytest.File):
    def collect(self):
        yield ScriptItem.from_parent(self, name=self.path.name)


class ScriptItem(pytest.Item):
    def runtest(self) -> None:
        proc = subprocess.run(
            [sys.executable, str(self.path)],
            cwd=HERE,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdin=subprocess.DEVNULL,
            env={**os.environ, CHILD_ENV: "1"},
            timeout=TIMEOUT_S,
        )
        if proc.returncode != 0:
            raise ScriptFailed(proc)

    def repr_failure(self, excinfo):
        if isinstance(excinfo.value, ScriptFailed):
            proc = excinfo.value.proc
            return f"exit {proc.returncode}\n--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
        return super().repr_failure(excinfo)

    def reportinfo(self):
        return self.path, None, self.name


class ScriptFailed(Exception):
    def __init__(self, proc: subprocess.CompletedProcess):
        super().__init__(proc.returncode)
        self.proc = proc
