#!/usr/bin/env python3
"""Extract public PDF file-list text and duration/count summaries.

Run from any directory with the bundled Python runtime and pdfplumber:
  python3 reproduce_extraction.py

Only files below this acquisition directory are read or written.
"""

from __future__ import annotations

import re
from pathlib import Path

import pdfplumber


HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
EXTRACTED = HERE / "extracted"
DURATION_RE = re.compile(r"(?<!\d)(\d{2}:\d{2}(?:\.\d{3})?)(?!\d)")


def seconds(value: str) -> float:
    minutes, sec = value.split(":", 1)
    return int(minutes) * 60 + float(sec)


def fmt_duration(total: float) -> str:
    hours = int(total // 3600)
    remainder = total - hours * 3600
    minutes = int(remainder // 60)
    sec = remainder - minutes * 60
    return f"{hours:02d}:{minutes:02d}:{sec:06.3f}"


def main() -> None:
    EXTRACTED.mkdir(parents=True, exist_ok=True)
    for pdf in sorted(RAW.glob("*.pdf")):
        with pdfplumber.open(pdf) as document:
            text = "\n\n".join(page.extract_text(layout=True) or "" for page in document.pages)
        output = EXTRACTED / f"{pdf.stem}.txt"
        output.write_text(text, encoding="utf-8")
        durations = DURATION_RE.findall(text)
        total = sum(seconds(value) for value in durations)
        print(
            f"{pdf.name}\tpages={len(document.pages)}\trows={len(durations)}"
            f"\ttotal={fmt_duration(total) if durations else 'N/A'}"
        )


if __name__ == "__main__":
    main()
