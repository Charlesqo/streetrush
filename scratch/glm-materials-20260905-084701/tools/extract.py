#!/usr/bin/env python3
"""Safe extractor for material ZIPs.

Rules (per task requirements):
- reject members with absolute paths (POSIX leading '/' or Windows drive letters)
- reject members containing '..' path components
- never overwrite existing files
- all writes must land inside the destination directory
Prints a JSON summary to stdout.
"""
import json
import os
import sys
import zipfile

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".exr", ".bmp", ".gif"}


def is_unsafe(name):
    # absolute paths: /foo, //foo, C:\foo, C:/foo
    if name.startswith("/"):
        return "absolute posix path"
    if len(name) >= 2 and name[1] == ":" and name[0].isalpha():
        return "windows drive-absolute path"
    if name.startswith("\\"):
        return "absolute windows path"
    # '..' in any component (handle both separators)
    parts = name.replace("\\", "/").split("/")
    if ".." in parts:
        return "contains '..' component"
    if "\x00" in name:
        return "contains NUL byte"
    return None


def main() -> int:
    if len(sys.argv) != 3:
        print(json.dumps({"error": "usage: extract.py <zip> <dest>"}))
        return 2
    zip_path, dest = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
    os.makedirs(dest, exist_ok=True)
    dest_real = os.path.realpath(dest)

    extracted, skipped, rejected = [], [], []
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            name = info.filename
            reason = is_unsafe(name)
            if reason:
                rejected.append({"member": name, "reason": reason})
                continue
            if name.endswith("/"):
                continue  # plain directory entry
            target = os.path.join(dest, *name.replace("\\", "/").split("/"))
            # hard guarantee: resolved target stays under dest
            if not os.path.realpath(target).startswith(dest_real + os.sep):
                rejected.append({"member": name, "reason": "escapes destination"})
                continue
            if os.path.lexists(target):
                skipped.append({"member": name, "reason": "target already exists"})
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as out:
                out.write(src.read())
            extracted.append(
                {
                    "member": name,
                    "path": os.path.relpath(target, os.path.dirname(dest)),
                    "bytes": info.file_size,
                }
            )

    print(
        json.dumps(
            {"zip": zip_path, "extracted": extracted, "skipped": skipped, "rejected": rejected},
            ensure_ascii=False,
            indent=1,
        )
    )
    return 0 if not rejected else 1


if __name__ == "__main__":
    sys.exit(main())
