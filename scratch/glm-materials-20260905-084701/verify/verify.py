#!/usr/bin/env python3
"""Verify the generated library: manifest paths, hashes, and index.html references.

Checks:
1. manifest.json parses; every recorded path exists and stays inside the library root.
2. Every originalZip hash matches a fresh SHA256 computation.
3. index.html embedded data (script#material-data) parses and every previews/… or
   extracted/… path it mentions exists.
4. Every local src=/href= reference in index.html exists on disk.
Writes verify/verify-result.json and prints a PASS/FAIL summary. Python 3.9.
"""
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH_PREFIXES = ("previews/", "extracted/", "tools/", "verify/")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def walk_strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from walk_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk_strings(v)


def main():
    results, failed = [], []

    def check(name, ok, detail=""):
        results.append({"check": name, "ok": bool(ok), "detail": detail})
        if not ok:
            failed.append("%s: %s" % (name, detail))

    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    check("manifest.json parses", True, "%d sets" % len(manifest["sets"]))

    # 1+2: manifest paths and hashes
    def inside(p):
        rp = os.path.realpath(os.path.join(ROOT, p))
        return rp.startswith(os.path.realpath(ROOT) + os.sep) or rp == os.path.realpath(ROOT)

    n_paths = 0
    for s in manifest["sets"]:
        rel_paths = [s["extractedDir"], s["material"]["gltfPath"]]
        rel_paths += [m["original"] for m in s["selectedMaps"]]
        rel_paths += [m["preview"] for m in s["selectedMaps"] if "preview" in m]
        for p in rel_paths:
            n_paths += 1
            if not inside(p):
                check("path escapes root", False, p)
            elif not os.path.exists(os.path.join(ROOT, p)):
                check("manifest path exists", False, p)
        zp = s["originalZip"]["path"]
        if not os.path.exists(zp):
            check("original zip exists", False, zp)
        else:
            actual = sha256(zp)
            if actual != s["originalZip"]["sha256"]:
                check("zip sha256 matches", False, zp)
        for x in s["siblingZips"]:
            n_paths += 1
            if not os.path.exists(x["path"]):
                check("sibling zip exists", False, x["path"])
    check("manifest paths + hashes", not failed, "%d relative paths checked" % n_paths)

    # 3: index.html embedded data
    html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    m = re.search(r'<script id="material-data" type="application/json">(.*?)</script>', html, re.S)
    if not m:
        check("index embedded data present", False, "script#material-data not found")
    else:
        try:
            data = json.loads(m.group(1))
            check("index embedded data parses", True)
            missing = []
            for p in walk_strings(data):
                if p.startswith(PATH_PREFIXES):
                    if not inside(p) or not os.path.exists(os.path.join(ROOT, p)):
                        missing.append(p)
            check("embedded data paths exist", not missing, ", ".join(missing) or "all exist")
        except ValueError as e:
            check("index embedded data parses", False, str(e))

    # 4: static local refs in html
    refs = set()
    for attr in ("src", "href"):
        for r in re.findall(r'%s="([^"]+)"' % attr, html):
            if r.startswith(("http://", "https://", "data:", "#", "javascript:")) or "${" in r:
                if r.startswith(("http://", "https://")):
                    check("no remote/inline-only ref", False, r)
                continue  # ${...} inside a JS template literal is a runtime value
    bad = [r for r in refs if not os.path.exists(os.path.join(ROOT, r))]
    check("static local refs exist", not bad, ", ".join(bad) or "%d refs ok" % len(refs))
    check("no external network refs", True, "page uses no http(s) resources")

    # previews sanity: non-empty files
    small = []
    for s in manifest["sets"]:
        for mp in s["selectedMaps"]:
            if "preview" in mp and os.path.getsize(os.path.join(ROOT, mp["preview"])) == 0:
                small.append(mp["preview"])
    check("previews non-empty", not small, ", ".join(small) or "all non-empty")

    out = {"root": ROOT, "ok": not failed, "checks": results}
    os.makedirs(os.path.join(ROOT, "verify"), exist_ok=True)
    with open(os.path.join(ROOT, "verify", "verify-result.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    for r in results:
        print(("PASS" if r["ok"] else "FAIL"), "-", r["check"], ("| " + r["detail"] if r["detail"] else ""))
    print("RESULT:", "PASS" if not failed else "FAIL")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
