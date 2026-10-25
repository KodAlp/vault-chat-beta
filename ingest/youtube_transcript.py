#!/usr/bin/env python3
"""YouTube transcript ingest sidecar — CLI contract:

    python ingest/youtube_transcript.py --url <url> --out-dir <dir> --lang tr,en

JSON-lines progress on stdout, one object per line (same contract as
convert.py):
    {"type": "progress", "stage": "fetching"|"parsing"}
    {"type": "done", "outPath": "...", "frontmatter": {...}, "warnings": [...]}
    {"type": "error", "message": "..."}

Only fetches captions/subtitles (manual or auto-generated) via yt-dlp —
never downloads video or audio, never runs local transcription. A video
with no captions in any requested language is reported as a clean error,
not a fallback to something heavier.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from postprocess import postprocess

VTT_TIMESTAMP = re.compile(r"^\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}")
VTT_INLINE_TAG = re.compile(r"<[^>]+>")


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


class _SilentLogger:
    """Passed as yt-dlp's `logger` option — belt-and-suspenders alongside
    `quiet`/`noprogress`: any stray debug/warning/error write yt-dlp makes
    must never reach stdout, since it isn't valid NDJSON and would either
    corrupt or get silently dropped by the Node-side reader (see the
    ydl_opts doc comment)."""

    def debug(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        pass

    def error(self, msg: str) -> None:
        pass


def vtt_to_text(vtt_path: Path) -> str:
    """Strips VTT structure (header, cue numbers, timestamps, inline
    <c>/<00:00:01.000> tags) down to plain lines, then drops consecutive
    duplicate lines. YouTube's auto-generated captions render as "rolling"
    cues where each new cue repeats most of the previous one's text, so a
    naive line-by-line join produces massive duplication."""
    raw = vtt_path.read_text(encoding="utf-8", errors="replace")

    out: list[str] = []
    last_line = None
    for line in raw.split("\n"):
        line = line.strip()
        if not line or line == "WEBVTT":
            continue
        if VTT_TIMESTAMP.match(line):
            continue
        if line.isdigit():  # cue number
            continue
        if line.startswith(("Kind:", "Language:")):
            continue
        line = VTT_INLINE_TAG.sub("", line).strip()
        if not line or line == last_line:
            continue
        out.append(line)
        last_line = line
    return "\n".join(out)


def _find_manual_key(lang: str, manual: dict) -> str | None:
    """A real manual-subtitle key is not always the bare language code —
    measured on a real MIT OCW video: the English manual track's key was
    `en-qlPKC2UN_YU`, a per-track suffix appended to the language code
    (BCP-47-shaped, like `en-US`). An exact `lang in manual` check missed
    it entirely and fell through to the auto-generated track below —
    silently swapping a human-made transcript for a machine one."""
    if lang in manual:
        return lang
    prefix = f"{lang}-"
    for key in manual:
        if key.startswith(prefix):
            return key
    return None


def _find_auto_original_key(lang: str, auto: dict, original_language: str | None) -> str | None:
    """Only the video's own original-language auto-caption, never a
    translated one. YouTube auto-translates its auto-generated captions
    into every UI language it supports, so `auto['tr']` on an English video
    is a machine translation of the English auto-caption — not a Turkish
    original. The `-orig` suffix is YouTube's own marker for the untranslated
    track when translations exist; `en-qlPKC2UN_YU`-style manual keys aside,
    this is the one place a suffix is load-bearing rather than noise."""
    orig_key = f"{lang}-orig"
    if orig_key in auto:
        return orig_key
    # No -orig marker present (a video whose auto-captions were never
    # translated into other languages has no reason to carry one) — accept
    # the bare key only when it demonstrably IS the video's spoken language,
    # never as an unverified stand-in for a translation.
    if lang in auto and original_language and lang == original_language:
        return lang
    return None


def find_subtitle_file(
    out_dir: Path,
    video_id: str,
    langs: list[str],
    manual: dict,
    auto: dict,
    original_language: str | None = None,
) -> tuple[Path, bool, str]:
    """Returns (path, is_auto, language_key actually used). A manual
    subtitle is preferred over an auto-generated one for the same language;
    walks the requested language list in priority order."""
    for lang in langs:
        key = _find_manual_key(lang, manual)
        if key:
            p = out_dir / f"{video_id}.{key}.vtt"
            if p.exists():
                return p, False, key
    for lang in langs:
        key = _find_auto_original_key(lang, auto, original_language)
        if key:
            p = out_dir / f"{video_id}.{key}.vtt"
            if p.exists():
                return p, True, key
    raise RuntimeError(
        "Bu videoda transkript/altyazı bulunamadı (istenen dillerde ne manuel ne de videonun "
        "kendi dilinde otomatik altyazı var — yalnızca çevrilmiş otomatik altyazılar mevcut olabilir)."
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--out-dir", dest="out_dir", required=True)
    parser.add_argument("--lang", default="tr,en")
    args = parser.parse_args()

    langs = [lang.strip() for lang in args.lang.split(",") if lang.strip()]
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        import yt_dlp
    except ImportError:
        emit({"type": "error", "message": "yt-dlp kurulu değil: pip install yt-dlp"})
        return 1

    emit({"type": "progress", "stage": "fetching"})
    # yt-dlp treats each subtitleslangs entry as a regex against the caption
    # keys it actually has (process_subtitles -> orderedSet_from_options(...,
    # use_regex=True)) — a bare "en" only downloads a track whose key is
    # exactly "en". Measured live on a real MIT OCW video: the manual
    # English track's key is "en-qlPKC2UN_YU" and the untranslated
    # auto-caption's is "en-orig"; requesting bare "en" downloaded neither,
    # only the (also real, but not what find_subtitle_file needs) auto "en"
    # and auto "tr" tracks — leaving nothing on disk for
    # _find_manual_key/_find_auto_original_key to actually select.
    # "{lang}(-.*)?" downloads every suffixed variant of each requested
    # language so the selection logic below has the real candidates to
    # choose from; matches this file's own prefix-matching semantics.
    subtitle_request_langs = [f"{lang}(-.*)?" for lang in langs]
    ydl_opts = {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": subtitle_request_langs,
        "subtitlesformat": "vtt",
        "outtmpl": str(out_dir / "%(id)s"),
        "quiet": True,
        "no_warnings": True,
        # `quiet` alone still lets yt-dlp's own progress-bar writer hit
        # stdout directly (via \r, no trailing \n) — that can land in the
        # middle of one of our own JSON lines and corrupt it for the
        # Node-side NDJSON reader. Silence both explicitly.
        "noprogress": True,
        "logger": _SilentLogger(),
        # A `watch?v=...&list=...` link (MIT OCW's own channel pages are
        # exactly this shape) is a playlist URL to yt-dlp, and without this
        # it downloads captions for every video in the list — youtubeQueue.ts
        # holds sharedJobMutex for the whole call, so an unbounded playlist
        # locks out every other conversion and the chat's own model swap
        # until it finishes (measured 2026-09-23).
        "noplaylist": True,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(args.url, download=True)
    except yt_dlp.utils.DownloadError as err:
        emit({"type": "error", "message": f"Video alınamadı: {err}"})
        return 1
    except Exception as err:  # noqa: BLE001 — surfaced to the caller as a clean message either way
        emit({"type": "error", "message": str(err)})
        return 1

    if not info:
        emit({"type": "error", "message": "Video bilgisi alınamadı."})
        return 1

    video_id = info.get("id", "")
    try:
        vtt_path, is_auto, subtitle_key = find_subtitle_file(
            out_dir,
            video_id,
            langs,
            info.get("subtitles") or {},
            info.get("automatic_captions") or {},
            info.get("language"),
        )
    except RuntimeError as err:
        emit({"type": "error", "message": str(err)})
        return 1

    emit({"type": "progress", "stage": "parsing"})
    transcript = vtt_to_text(vtt_path)
    if not transcript.strip():
        emit({"type": "error", "message": "Altyazı dosyası boş çıktı."})
        return 1

    video_title = info.get("title") or video_id
    # A heading anchor for derive_title() (postprocess.py) and the chunker
    # (indexer/chunk.ts depends on a heading tree) — a raw transcript has
    # none of its own.
    body = f"# {video_title}\n\n{transcript}"
    final_text, frontmatter = postprocess(
        body, title_fallback=video_title, converted_by="youtube-transcript", needs_review=is_auto
    )
    frontmatter["source_url"] = info.get("webpage_url", args.url)
    frontmatter["video_id"] = video_id
    frontmatter["channel"] = info.get("uploader", "")
    # The subtitle track actually used, not the requested --lang list — the
    # base language code out of whatever key it was (plain "en", a suffixed
    # manual key like "en-qlPKC2UN_YU", or an auto "en-orig"). Frontmatter
    # carried no signal of this before; a cross-lingual query landing on
    # this note now has one.
    frontmatter["language"] = subtitle_key.split("-")[0]

    out_path = out_dir / f"{video_id or 'video'}.md"
    fm_lines = "\n".join(f"{k}: {json.dumps(v)}" for k, v in frontmatter.items())
    out_path.write_text(f"---\n{fm_lines}\n---\n\n{final_text}", encoding="utf-8")

    emit({"type": "done", "outPath": str(out_path), "frontmatter": frontmatter, "warnings": []})
    return 0


if __name__ == "__main__":
    sys.exit(main())
