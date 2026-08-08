#!/usr/bin/env python3
"""YouTube transcript ingest sidecar — CLI contract owned by the
source-ingest skill doc:

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


def find_subtitle_file(
    out_dir: Path, video_id: str, langs: list[str], manual: dict, auto: dict
) -> tuple[Path, bool]:
    """Returns (path, is_auto). A manual subtitle is preferred over an
    auto-generated one for the same language; walks the requested language
    list in priority order."""
    for lang in langs:
        if lang in manual:
            p = out_dir / f"{video_id}.{lang}.vtt"
            if p.exists():
                return p, False
    for lang in langs:
        if lang in auto:
            p = out_dir / f"{video_id}.{lang}.vtt"
            if p.exists():
                return p, True
    raise RuntimeError(
        "Bu videoda transkript/altyazı bulunamadı (istenen dillerde ne manuel ne otomatik altyazı var)."
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
    ydl_opts = {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": langs,
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
        vtt_path, is_auto = find_subtitle_file(
            out_dir, video_id, langs, info.get("subtitles") or {}, info.get("automatic_captions") or {}
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

    out_path = out_dir / f"{video_id or 'video'}.md"
    fm_lines = "\n".join(f"{k}: {json.dumps(v)}" for k, v in frontmatter.items())
    out_path.write_text(f"---\n{fm_lines}\n---\n\n{final_text}", encoding="utf-8")

    emit({"type": "done", "outPath": str(out_path), "frontmatter": frontmatter, "warnings": []})
    return 0


if __name__ == "__main__":
    sys.exit(main())
