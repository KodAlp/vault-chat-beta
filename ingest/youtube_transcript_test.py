# -*- coding: utf-8 -*-
"""Tests for youtube_transcript.py's subtitle-track selection.

    python ingest/youtube_transcript_test.py

Not part of `npm test` (plain Python, run separately — same convention as
postprocess_test.py/heading_repair_test.py). Every check here exists
because of a real failure, measured on a real MIT OCW video
(ryLdyDrBfvI, 2026-09-23):

- Manual English captions existed but under the key `en-qlPKC2UN_YU`, not
  plain `en` — an exact `lang in manual` check missed them and fell through
  to the auto-generated track.
- The auto-generated track dict had 157 language keys (every UI translation
  YouTube offers), including `tr`. Requesting `--lang tr,en` (the app's
  fixed default) picked the Turkish machine translation of the English
  auto-caption instead of the English auto-caption itself, because nothing
  distinguished "this video's own language, auto-transcribed" from "someone
  else's language, then machine-translated into this one".
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from youtube_transcript import (  # noqa: E402
    _find_auto_original_key,
    _find_manual_key,
    find_subtitle_file,
    vtt_to_text,
)

failures: list[str] = []


def check(name: str, ok: bool) -> None:
    print(("PASS  " if ok else "FAIL  ") + name)
    if not ok:
        failures.append(name)


def test_find_manual_key() -> None:
    # The real MIT OCW shape: a suffixed key, no plain "en".
    manual = {"en-qlPKC2UN_YU": [...], "fr-c5nsfXRKC_k": [...]}
    check("suffixed manual key found by prefix", _find_manual_key("en", manual) == "en-qlPKC2UN_YU")
    check("exact key preferred when both would match", _find_manual_key("fr", {"fr": [...], "fr-x": [...]}) == "fr")
    check("no match returns None, not a wrong language", _find_manual_key("de", manual) is None)
    # "en" must not prefix-match "eng" or an unrelated code that merely
    # starts with the same two letters without a BCP-47 separator.
    check("prefix match requires the '-' separator", _find_manual_key("en", {"english": [...]}) is None)


def test_find_auto_original_key() -> None:
    # 157-language auto dict, video is actually English.
    auto = {lang: [...] for lang in ["tr", "en-orig", "fr", "de", "es", "ja"]}
    check("'-orig' key preferred over a bare match", _find_auto_original_key("en", auto, "en") == "en-orig")
    check(
        "a translated language is never accepted, even though it's a real key in `auto`",
        _find_auto_original_key("tr", auto, "en") is None,
    )
    check(
        "no -orig marker, but the language really is the video's own — accepted",
        _find_auto_original_key("tr", {"tr": [...]}, "tr") == "tr",
    )
    check(
        "no -orig marker and no confirmed original language — refused, not guessed",
        _find_auto_original_key("tr", {"tr": [...]}, None) is None,
    )
    check(
        "bare key present but original_language says otherwise — refused",
        _find_auto_original_key("tr", {"tr": [...]}, "en") is None,
    )


def test_find_subtitle_file_prefers_manual_over_auto() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp)
        (out_dir / "vid123.en-qlPKC2UN_YU.vtt").write_text("WEBVTT\n\ndummy", encoding="utf-8")
        (out_dir / "vid123.en-orig.vtt").write_text("WEBVTT\n\nauto dummy", encoding="utf-8")
        manual = {"en-qlPKC2UN_YU": [...]}
        auto = {"en-orig": [...], "tr": [...]}
        path, is_auto, key = find_subtitle_file(out_dir, "vid123", ["tr", "en"], manual, auto, "en")
        check("manual subtitle chosen over auto even though 'tr' would match auto first", not is_auto)
        check("the suffixed manual key was the one actually used", key == "en-qlPKC2UN_YU")  # gitleaks:allow (dil anahtarı, sır değil)
        check("path points at the manual file", path.name == "vid123.en-qlPKC2UN_YU.vtt")


def test_find_subtitle_file_reproduces_the_real_bug_fixed() -> None:
    """No manual captions at all (measured shape after the manual-key fix
    still fails to match) — must land on the English auto-original, never
    the Turkish auto-translation, even though 'tr' is requested first."""
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp)
        (out_dir / "vid456.tr.vtt").write_text("WEBVTT\n\nTürkçe çeviri", encoding="utf-8")
        (out_dir / "vid456.en-orig.vtt").write_text("WEBVTT\n\noriginal English", encoding="utf-8")
        manual: dict = {}
        auto = {"tr": [...], "en-orig": [...], "de": [...], "fr": [...]}
        path, is_auto, key = find_subtitle_file(out_dir, "vid456", ["tr", "en"], manual, auto, "en")
        check("auto track chosen (no manual captions exist)", is_auto)
        check(
            "English auto-original chosen over the Turkish machine translation, "
            "despite 'tr' being requested first — this was the actual bug",
            key == "en-orig",
        )


def test_find_subtitle_file_no_match_raises_clean_error() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp)
        try:
            find_subtitle_file(out_dir, "vid789", ["tr", "en"], {}, {"ja": [...]}, "ja")
            check("should have raised when nothing in the requested languages exists", False)
        except RuntimeError as err:
            check("clean RuntimeError, not an unhandled KeyError/AttributeError", "Bu videoda" in str(err))


def test_vtt_to_text_dedupes_rolling_captions() -> None:
    vtt = (
        "WEBVTT\nKind: captions\nLanguage: en\n\n"
        "00:00:00.000 --> 00:00:02.000\nHello there\n\n"
        "00:00:02.000 --> 00:00:04.000\nHello there\nhow are you\n\n"
        "00:00:04.000 --> 00:00:06.000\nhow are you\ntoday\n"
    )
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "x.vtt"
        p.write_text(vtt, encoding="utf-8")
        text = vtt_to_text(p)
        check("rolling-caption duplicate lines collapsed", text == "Hello there\nhow are you\ntoday")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    test_find_manual_key()
    test_find_auto_original_key()
    test_find_subtitle_file_prefers_manual_over_auto()
    test_find_subtitle_file_reproduces_the_real_bug_fixed()
    test_find_subtitle_file_no_match_raises_clean_error()
    test_vtt_to_text_dedupes_rolling_captions()
    print(f"\n{len(failures)} başarısız" if failures else "\nhepsi geçti")
    sys.exit(1 if failures else 0)
