#!/usr/bin/env python3
"""Competitor audio analysis (FEAT-001).

For each competitor MP4 this:
  * extracts the full audio stream to a 16 kHz mono WAV (temp),
  * transcribes it with faster-whisper (word timestamps) to derive word counts,
  * runs ffmpeg silencedetect to measure pauses / true silence,
  * computes overall WPM, speech-only WPM, median pause, pauses > 0.70 s, % true silence.

Outputs (under .scratch/audio-analysis/):
  * transcripts/<name>.txt   full transcript text
  * transcripts/<name>.json  segment + word timing
  * timeline.csv             per-segment rows across all videos
  * summary.csv              one row per video with the headline metrics
  * all-analysis.json        full structured results

Env: FFMPEG_PATH, FFPROBE_PATH (fall back to ffmpeg-static / ffprobe-static binaries).
"""
import csv
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(os.getcwd())
COMP_DIR = ROOT / ".scratch" / "competitors"
OUT_DIR = ROOT / ".scratch" / "audio-analysis"
TX_DIR = OUT_DIR / "transcripts"

VIDEOS = [
    ("reported", "reported.mp4"),
    ("lived", "lived.mp4"),
    ("noob-vs-pro", "noob-vs-pro.mp4"),
]

SILENCE_NOISE_DB = "-30dB"   # below this RMS counts as silence
SILENCE_MIN_DUR = 0.20       # minimum silence to report (seconds)
PAUSE_LONG_THRESHOLD = 0.70  # pauses longer than this are flagged


def resolve_bin(env_var, node_expr):
    val = os.environ.get(env_var)
    if val:
        return val
    out = subprocess.check_output(
        ["node", "-e", node_expr], cwd=str(ROOT), text=True
    ).strip()
    return out


FFMPEG = resolve_bin(
    "FFMPEG_PATH",
    "import('ffmpeg-static').then(m=>process.stdout.write(m.default))",
)
FFPROBE = resolve_bin(
    "FFPROBE_PATH",
    "import('ffprobe-static').then(m=>process.stdout.write(m.default.path))",
)


def audio_duration(path):
    out = subprocess.check_output(
        [
            FFPROBE, "-v", "error", "-select_streams", "a:0",
            "-show_entries", "format=duration:stream=duration",
            "-of", "default=nokey=1:noprint_wrappers=1", str(path),
        ],
        text=True,
    )
    vals = [float(x) for x in out.split() if x.strip()]
    return max(vals) if vals else 0.0


def extract_wav(src, dst):
    subprocess.run(
        [
            FFMPEG, "-hide_banner", "-y", "-i", str(src),
            "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", str(dst),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def silence_intervals(wav, total_dur):
    """Return (silences[list of (start,end)], speech_seconds)."""
    proc = subprocess.run(
        [
            FFMPEG, "-hide_banner", "-i", str(wav),
            "-af", f"silencedetect=noise={SILENCE_NOISE_DB}:d={SILENCE_MIN_DUR}",
            "-f", "null", "-",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    stderr = proc.stderr
    starts = [float(m) for m in re.findall(r"silence_start:\s*([0-9.]+)", stderr)]
    ends = [float(m) for m in re.findall(r"silence_end:\s*([0-9.]+)", stderr)]
    silences = []
    for i, s in enumerate(starts):
        e = ends[i] if i < len(ends) else total_dur
        silences.append((s, min(e, total_dur)))
    silence_total = sum(e - s for s, e in silences)
    speech_total = max(0.0, total_dur - silence_total)
    return silences, speech_total


def inter_word_pauses(words):
    """Gaps between consecutive whisper words (seconds)."""
    gaps = []
    for i in range(1, len(words)):
        gap = words[i]["start"] - words[i - 1]["end"]
        if gap > 0:
            gaps.append(gap)
    return gaps


def main():
    TX_DIR.mkdir(parents=True, exist_ok=True)
    from faster_whisper import WhisperModel

    sys.stderr.write("[audio] loading whisper base model...\n")
    model = WhisperModel("base", device="cpu", compute_type="int8")

    all_results = []
    timeline_rows = []

    for name, fname in VIDEOS:
        src = COMP_DIR / fname
        sys.stderr.write(f"[audio] analyzing {name}...\n")
        total_dur = audio_duration(src)
        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / f"{name}.wav"
            extract_wav(src, wav)
            silences, speech_total = silence_intervals(wav, total_dur)

            segments, info = model.transcribe(
                str(wav), word_timestamps=True, vad_filter=False
            )
            seg_list = []
            words = []
            text_parts = []
            for seg in segments:
                seg_words = []
                for w in (seg.words or []):
                    wd = {
                        "word": w.word,
                        "start": round(w.start, 3),
                        "end": round(w.end, 3),
                    }
                    words.append(wd)
                    seg_words.append(wd)
                seg_list.append(
                    {
                        "start": round(seg.start, 3),
                        "end": round(seg.end, 3),
                        "text": seg.text.strip(),
                        "words": seg_words,
                    }
                )
                text_parts.append(seg.text.strip())
                timeline_rows.append(
                    {
                        "video": name,
                        "seg_start": round(seg.start, 3),
                        "seg_end": round(seg.end, 3),
                        "seg_dur": round(seg.end - seg.start, 3),
                        "word_count": len(seg_words),
                        "text": seg.text.strip(),
                    }
                )

            transcript_text = " ".join(text_parts).strip()
            word_count = len(words)
            # If whisper produced no word timings, fall back to token split.
            if word_count == 0 and transcript_text:
                word_count = len(transcript_text.split())

            gaps = inter_word_pauses(words)
            long_pauses = [g for g in gaps if g > PAUSE_LONG_THRESHOLD]
            median_pause = round(statistics.median(gaps), 3) if gaps else 0.0

            overall_wpm = round(word_count / (total_dur / 60.0), 1) if total_dur else 0.0
            speech_wpm = (
                round(word_count / (speech_total / 60.0), 1) if speech_total else 0.0
            )
            silence_total = sum(e - s for s, e in silences)
            pct_silence = round((silence_total / total_dur) * 100, 1) if total_dur else 0.0

            # Write transcripts
            (TX_DIR / f"{name}.txt").write_text(transcript_text + "\n")
            (TX_DIR / f"{name}.json").write_text(
                json.dumps(
                    {
                        "video": name,
                        "language": info.language,
                        "language_probability": round(info.language_probability, 3),
                        "duration": round(total_dur, 3),
                        "segments": seg_list,
                    },
                    indent=2,
                )
            )

            result = {
                "video": name,
                "file": fname,
                "audioDurationSec": round(total_dur, 3),
                "speechSec": round(speech_total, 3),
                "trueSilenceSec": round(silence_total, 3),
                "pctTrueSilence": pct_silence,
                "wordCount": word_count,
                "overallWpm": overall_wpm,
                "speechOnlyWpm": speech_wpm,
                "medianPauseSec": median_pause,
                "pausesOver0_70s": len(long_pauses),
                "silenceNoiseDb": SILENCE_NOISE_DB,
                "silenceMinDurSec": SILENCE_MIN_DUR,
                "language": info.language,
            }
            all_results.append(result)
            sys.stderr.write(
                f"[audio] {name}: dur={result['audioDurationSec']}s words={word_count} "
                f"overallWPM={overall_wpm} speechWPM={speech_wpm} "
                f"medPause={median_pause}s pauses>0.7s={len(long_pauses)} "
                f"silence={pct_silence}%\n"
            )

    # summary.csv
    with (OUT_DIR / "summary.csv").open("w", newline="") as f:
        cols = [
            "video", "file", "audioDurationSec", "speechSec", "trueSilenceSec",
            "pctTrueSilence", "wordCount", "overallWpm", "speechOnlyWpm",
            "medianPauseSec", "pausesOver0_70s", "language",
        ]
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in all_results:
            w.writerow(r)

    # timeline.csv
    with (OUT_DIR / "timeline.csv").open("w", newline="") as f:
        cols = ["video", "seg_start", "seg_end", "seg_dur", "word_count", "text"]
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for row in timeline_rows:
            w.writerow(row)

    # all-analysis.json
    (OUT_DIR / "all-analysis.json").write_text(
        json.dumps(
            {
                "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
                "ffmpeg": FFMPEG,
                "ffprobe": FFPROBE,
                "params": {
                    "silenceNoiseDb": SILENCE_NOISE_DB,
                    "silenceMinDurSec": SILENCE_MIN_DUR,
                    "pauseLongThresholdSec": PAUSE_LONG_THRESHOLD,
                    "whisperModel": "base",
                },
                "videos": all_results,
            },
            indent=2,
        )
    )
    sys.stderr.write(f"[audio] wrote {OUT_DIR / 'summary.csv'}, timeline.csv, all-analysis.json\n")


if __name__ == "__main__":
    main()
