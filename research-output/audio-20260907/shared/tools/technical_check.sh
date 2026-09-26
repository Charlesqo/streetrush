#!/usr/bin/env bash
set -u

ROOT="/Volumes/Storage/streetrush/research-output/audio-20260907/shared"
OUT="$ROOT/evidence/technical_check.tsv"
HASH="$ROOT/evidence/checksums.tsv"
mkdir -p "$ROOT/evidence"
printf '%s\n' 'path	bytes	sha256	ffprobe_status	ffprobe_summary' > "$OUT"
printf '%s\n' 'path	bytes	sha256' > "$HASH"

find "$ROOT/originals" "$ROOT/previews/selected" -type f \( -iname '*.wav' -o -iname '*.ogg' -o -iname '*.mp3' -o -iname '*.m4a' -o -iname '*.flac' \) -print0 |
while IFS= read -r -d '' file; do
  rel="${file#"$ROOT/"}"
  bytes="$(stat -f %z "$file")"
  sha="$(shasum -a 256 "$file" | awk '{print $1}')"
  set +e
  summary="$(ffprobe -v error -show_entries format=duration:stream=codec_name,sample_rate,channels -of default=noprint_wrappers=1:nokey=1 "$file" 2>/dev/null | paste -sd '|' -)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    state="DECODE_OK"
  else
    state="DECODE_FAIL"
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$rel" "$bytes" "$sha" "$state" "$summary" >> "$OUT"
  printf '%s\t%s\t%s\n' "$rel" "$bytes" "$sha" >> "$HASH"
done
