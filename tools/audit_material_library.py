#!/usr/bin/env python3
"""Read-only inventory for a ZIP-based material library.

The scanner reads ZIP central directories, small embedded JSON/glTF metadata, and
the leading bytes of image members. It never extracts an archive and never
writes to the material library.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import stat
import struct
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple


DEFAULT_LIBRARY = Path("/Volumes/Charles/下载/赛车游戏 材质")
SCRIPT_VERSION = 1
MAX_IMAGE_HEADER_BYTES = 256 * 1024
DEFAULT_MAX_METADATA_BYTES = 4 * 1024 * 1024

ARCHIVE_NAME_RE = re.compile(
    r"^(?P<label>.+)_(?P<asset_id>[a-z0-9]{8,})_"
    r"(?P<resolution>[1248]k)(?:_(?P<flavor>.+))?\.zip$",
    re.IGNORECASE,
)
RESOLUTION_TOKEN_RE = re.compile(r"(?<!\d)(1k|2k|4k|8k)(?!\w)", re.IGNORECASE)
LICENSE_KEY_RE = re.compile(
    r"(?:licen[cs]e|copyright|attribution|author|creator|rights|legal|terms)",
    re.IGNORECASE,
)
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".exr", ".webp", ".tif", ".tiff"}
METADATA_SUFFIXES = {".json", ".gltf"}

CHANNEL_PATTERNS: Sequence[Tuple[str, re.Pattern[str]]] = (
    ("basecolor+opacity", re.compile(r"(?:^|[_-])b-o(?:[_.-]|$)", re.I)),
    ("packed-orm", re.compile(r"(?:^|[_-])orm(?:[_.-]|$)", re.I)),
    ("basecolor", re.compile(r"(?:basecolou?r|albedo|diffuse|(?:^|[_-])b(?:[_.-]|$))", re.I)),
    ("normal", re.compile(r"(?:normal|(?:^|[_-])n(?:[_.-]|$))", re.I)),
    ("roughness", re.compile(r"roughness", re.I)),
    ("gloss", re.compile(r"gloss", re.I)),
    ("ao", re.compile(r"(?:ambient[_-]?occlusion|(?:^|[_-])ao(?:[_.-]|$))", re.I)),
    ("displacement", re.compile(r"(?:displacement|height)", re.I)),
    ("bump", re.compile(r"bump", re.I)),
    ("cavity", re.compile(r"cavity", re.I)),
    ("opacity", re.compile(r"(?:opacity|alpha)", re.I)),
    ("specular", re.compile(r"specular", re.I)),
)


def human_bytes(value: int) -> str:
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    amount = float(value)
    for unit in units:
        if abs(amount) < 1024.0 or unit == units[-1]:
            if unit == "B":
                return f"{int(amount)} {unit}"
            return f"{amount:.2f} {unit}"
        amount /= 1024.0
    return f"{value} B"


def normalize_resolution(value: Optional[str]) -> Optional[str]:
    return value.lower() if isinstance(value, str) else None


def classify_channel(name: str) -> Optional[str]:
    basename = PurePosixPath(name).name
    for label, pattern in CHANNEL_PATTERNS:
        if pattern.search(basename):
            return label
    return None


def archive_descriptor(path: Path) -> Dict[str, Optional[str]]:
    match = ARCHIVE_NAME_RE.match(path.name)
    if not match:
        return {
            "label": path.stem,
            "asset_id": None,
            "resolution": None,
            "flavor": None,
        }
    groups = match.groupdict()
    return {
        "label": groups["label"],
        "asset_id": groups["asset_id"].lower(),
        "resolution": normalize_resolution(groups["resolution"]),
        "flavor": groups["flavor"].lower() if groups["flavor"] else "standard",
    }


def read_prefix(zf: zipfile.ZipFile, info: zipfile.ZipInfo, limit: int) -> bytes:
    with zf.open(info, "r") as source:
        return source.read(limit)


def png_dimensions(data: bytes) -> Optional[Tuple[int, int]]:
    if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    return None


def jpeg_dimensions(data: bytes) -> Optional[Tuple[int, int]]:
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        return None
    offset = 2
    standalone_markers = {0x01, *range(0xD0, 0xD9)}
    sof_markers = {
        *range(0xC0, 0xC4),
        *range(0xC5, 0xC8),
        *range(0xC9, 0xCC),
        *range(0xCD, 0xD0),
    }
    while offset + 3 < len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            return None
        marker = data[offset]
        offset += 1
        if marker in standalone_markers:
            continue
        if offset + 2 > len(data):
            return None
        segment_length = struct.unpack(">H", data[offset : offset + 2])[0]
        if segment_length < 2 or offset + segment_length > len(data):
            return None
        if marker in sof_markers and segment_length >= 7:
            height, width = struct.unpack(">HH", data[offset + 3 : offset + 7])
            return width, height
        offset += segment_length
    return None


def exr_dimensions(data: bytes) -> Optional[Tuple[int, int]]:
    # OpenEXR: magic, version, then NUL-terminated name/type + size/value attrs.
    if len(data) < 12 or data[:4] != b"\x76\x2f\x31\x01":
        return None
    offset = 8

    def read_c_string(position: int) -> Tuple[Optional[str], int]:
        end = data.find(b"\x00", position)
        if end < 0:
            return None, len(data)
        try:
            value = data[position:end].decode("ascii")
        except UnicodeDecodeError:
            return None, len(data)
        return value, end + 1

    while offset < len(data):
        name, offset = read_c_string(offset)
        if name is None:
            return None
        if not name:
            return None
        attr_type, offset = read_c_string(offset)
        if attr_type is None or offset + 4 > len(data):
            return None
        size = struct.unpack("<I", data[offset : offset + 4])[0]
        offset += 4
        end = offset + size
        if end > len(data):
            return None
        if name == "dataWindow" and attr_type == "box2i" and size >= 16:
            x_min, y_min, x_max, y_max = struct.unpack("<iiii", data[offset : offset + 16])
            width = x_max - x_min + 1
            height = y_max - y_min + 1
            if width > 0 and height > 0:
                return width, height
            return None
        offset = end
    return None


def image_dimensions(name: str, data: bytes) -> Optional[Tuple[int, int]]:
    suffix = PurePosixPath(name).suffix.lower()
    if suffix == ".png":
        return png_dimensions(data)
    if suffix in {".jpg", ".jpeg"}:
        return jpeg_dimensions(data)
    if suffix == ".exr":
        return exr_dimensions(data)
    return None


def safe_member_name(name: str) -> bool:
    path = PurePosixPath(name)
    return not path.is_absolute() and ".." not in path.parts


def is_symlink(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0xFFFF
    return stat.S_ISLNK(mode)


def parse_json_document(
    zf: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    max_metadata_bytes: int,
) -> Tuple[Optional[Any], Optional[str]]:
    if info.file_size > max_metadata_bytes:
        return None, f"metadata too large ({human_bytes(info.file_size)})"
    try:
        payload = zf.read(info)
        return json.loads(payload.decode("utf-8-sig")), None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, RuntimeError) as error:
        return None, str(error)


def walk_license_fields(value: Any, path: str = "$") -> Iterable[Dict[str, Any]]:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if LICENSE_KEY_RE.search(str(key)):
                if isinstance(child, (str, int, float, bool)) or child is None:
                    yield {"path": child_path, "value": child}
                else:
                    yield {"path": child_path, "value_type": type(child).__name__}
            yield from walk_license_fields(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk_license_fields(child, f"{path}[{index}]")


def metadata_summary(document: Any) -> Dict[str, Any]:
    if not isinstance(document, dict):
        return {}
    meta_values: Dict[str, Any] = {}
    for item in document.get("meta", []):
        if isinstance(item, dict) and isinstance(item.get("key"), str):
            meta_values[item["key"]] = item.get("value")
    maps = document.get("maps", [])
    map_channels: Set[str] = set()
    map_physical_sizes: Set[str] = set()
    map_resolutions: Set[str] = set()
    if isinstance(maps, list):
        for texture_map in maps:
            if not isinstance(texture_map, dict):
                continue
            if isinstance(texture_map.get("type"), str):
                map_channels.add(texture_map["type"].lower())
            if texture_map.get("physicalSize"):
                map_physical_sizes.add(str(texture_map["physicalSize"]))
            if texture_map.get("resolution"):
                map_resolutions.add(str(texture_map["resolution"]))
    physical_sizes = set(map_physical_sizes)
    if document.get("physicalSize"):
        physical_sizes.add(str(document["physicalSize"]))
    scan_area = meta_values.get("scanArea")
    if scan_area:
        physical_sizes.add(str(scan_area).removesuffix(" m"))
    semantic_tags = document.get("semanticTags")
    semantic_resolution = semantic_tags.get("resolution") if isinstance(semantic_tags, dict) else None
    return {
        "asset_id": document.get("id"),
        "name": document.get("name"),
        "categories": sorted(str(item) for item in document.get("categories", []) if item),
        "highest_available_res": document.get("highest_available_res"),
        "semantic_resolution": semantic_resolution,
        "physical_sizes_m": sorted(physical_sizes),
        "height_m": meta_values.get("height"),
        "tileable": meta_values.get("tileable"),
        "texel_density": meta_values.get("texelDensity") or document.get("texelDensity"),
        "map_channels": sorted(map_channels),
        "map_resolutions": sorted(map_resolutions),
        "license_fields": list(walk_license_fields(document)),
    }


def merge_metadata(summaries: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    values = list(summaries)

    def unique(field: str) -> List[Any]:
        result: Dict[str, Any] = {}
        for summary in values:
            value = summary.get(field)
            if value is None or value == "" or value == []:
                continue
            candidates = value if isinstance(value, list) else [value]
            for candidate in candidates:
                result[json.dumps(candidate, ensure_ascii=False, sort_keys=True)] = candidate
        return [result[key] for key in sorted(result)]

    return {
        "asset_ids": unique("asset_id"),
        "names": unique("name"),
        "categories": unique("categories"),
        "highest_available_res": unique("highest_available_res"),
        "semantic_resolution": unique("semantic_resolution"),
        "physical_sizes_m": unique("physical_sizes_m"),
        "height_m": unique("height_m"),
        "tileable": unique("tileable"),
        "texel_density": unique("texel_density"),
        "map_channels": unique("map_channels"),
        "map_resolutions": unique("map_resolutions"),
        "license_fields": unique("license_fields"),
    }


def audit_archive(
    path: Path,
    image_cache: Dict[Tuple[int, int, str], Optional[Tuple[int, int]]],
    metadata_cache: Dict[Tuple[int, int], Tuple[Optional[Any], Optional[str]]],
    max_metadata_bytes: int,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    descriptor = archive_descriptor(path)
    result: Dict[str, Any] = {
        "archive": path.name,
        "archive_bytes": path.stat().st_size,
        **descriptor,
        "entry_count": 0,
        "file_count": 0,
        "directory_count": 0,
        "compressed_payload_bytes": 0,
        "uncompressed_payload_bytes": 0,
        "formats": {},
        "channels": [],
        "image_dimensions": [],
        "metadata": [],
        "members": [],
        "warnings": [],
    }
    occurrences: List[Dict[str, Any]] = []
    try:
        with zipfile.ZipFile(path, "r", allowZip64=True) as zf:
            infos = sorted(zf.infolist(), key=lambda item: item.filename)
            result["entry_count"] = len(infos)
            format_counts: collections.Counter[str] = collections.Counter()
            channels: Set[str] = set()
            dimensions_seen: Set[Tuple[str, int, int]] = set()
            metadata_documents: List[Dict[str, Any]] = []
            for info in infos:
                if info.is_dir():
                    result["directory_count"] += 1
                    continue
                result["file_count"] += 1
                result["compressed_payload_bytes"] += info.compress_size
                result["uncompressed_payload_bytes"] += info.file_size
                suffix = PurePosixPath(info.filename).suffix.lower() or "[none]"
                format_counts[suffix] += 1
                channel = classify_channel(info.filename)
                if channel:
                    channels.add(channel)
                if not safe_member_name(info.filename):
                    result["warnings"].append(f"unsafe member path: {info.filename}")
                if info.flag_bits & 0x1:
                    result["warnings"].append(f"encrypted member: {info.filename}")
                if is_symlink(info):
                    result["warnings"].append(f"symlink member: {info.filename}")
                occurrence = {
                    "archive": path.name,
                    "member": info.filename,
                    "basename": PurePosixPath(info.filename).name,
                    "size": info.file_size,
                    "compressed_size": info.compress_size,
                    "crc32": f"{info.CRC:08x}",
                    "suffix": suffix,
                    "channel": channel,
                }
                occurrences.append(occurrence)
                if suffix in IMAGE_SUFFIXES:
                    cache_key = (info.CRC, info.file_size, suffix)
                    if cache_key not in image_cache:
                        try:
                            prefix = read_prefix(zf, info, MAX_IMAGE_HEADER_BYTES)
                            image_cache[cache_key] = image_dimensions(info.filename, prefix)
                        except (OSError, RuntimeError, zipfile.BadZipFile) as error:
                            image_cache[cache_key] = None
                            result["warnings"].append(
                                f"image header unreadable: {info.filename}: {error}"
                            )
                    dimensions = image_cache[cache_key]
                    if dimensions:
                        occurrence["width"], occurrence["height"] = dimensions
                        dimensions_seen.add((info.filename, dimensions[0], dimensions[1]))
                    else:
                        token = RESOLUTION_TOKEN_RE.search(info.filename)
                        if token:
                            inferred = int(token.group(1)[0]) * 1024
                            occurrence["inferred_width"] = inferred
                            occurrence["inferred_height"] = inferred
                if suffix in METADATA_SUFFIXES:
                    cache_key = (info.CRC, info.file_size)
                    if cache_key not in metadata_cache:
                        metadata_cache[cache_key] = parse_json_document(
                            zf, info, max_metadata_bytes
                        )
                    document, error = metadata_cache[cache_key]
                    if error:
                        result["warnings"].append(
                            f"metadata unreadable: {info.filename}: {error}"
                        )
                    elif document is not None:
                        summary = metadata_summary(document)
                        summary["member"] = info.filename
                        summary["kind"] = suffix.removeprefix(".")
                        metadata_documents.append(summary)
            result["formats"] = dict(sorted(format_counts.items()))
            result["channels"] = sorted(channels)
            result["image_dimensions"] = [
                {"member": name, "width": width, "height": height}
                for name, width, height in sorted(dimensions_seen)
            ]
            result["metadata"] = metadata_documents
            result["members"] = occurrences
            result["warnings"] = sorted(set(result["warnings"]))
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        result["warnings"].append(f"archive unreadable: {error}")
    return result, occurrences


def flatten_unique(values: Iterable[Any]) -> List[Any]:
    result: Dict[str, Any] = {}
    for value in values:
        candidates = value if isinstance(value, list) else [value]
        for candidate in candidates:
            if candidate is None or candidate == "":
                continue
            result[json.dumps(candidate, ensure_ascii=False, sort_keys=True)] = candidate
    return [result[key] for key in sorted(result)]


def duplicate_payload_groups(occurrences: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    grouped: Dict[Tuple[str, int], List[Dict[str, Any]]] = collections.defaultdict(list)
    for occurrence in occurrences:
        grouped[(occurrence["crc32"], occurrence["size"])].append(occurrence)
    duplicates: List[Dict[str, Any]] = []
    for (crc32, size), group in grouped.items():
        archives = sorted({item["archive"] for item in group})
        if len(archives) < 2:
            continue
        duplicates.append(
            {
                "crc32": crc32,
                "uncompressed_bytes_each": size,
                "occurrences": len(group),
                "archive_count": len(archives),
                "redundant_uncompressed_bytes": size * (len(group) - 1),
                "members": [
                    {"archive": archive, "member": member}
                    for archive, member in sorted(
                        {(item["archive"], item["member"]) for item in group}
                    )
                ],
            }
        )
    return sorted(
        duplicates,
        key=lambda item: (
            -item["redundant_uncompressed_bytes"],
            item["crc32"],
            item["uncompressed_bytes_each"],
        ),
    )


def asset_key_for_archive(archive: Dict[str, Any]) -> str:
    if archive.get("asset_id"):
        return str(archive["asset_id"])
    for metadata in archive.get("metadata", []):
        if metadata.get("asset_id"):
            return str(metadata["asset_id"]).lower()
    return f"unknown:{archive['archive']}"


def build_asset_summaries(
    archives: Sequence[Dict[str, Any]],
    occurrences: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    archives_by_asset: Dict[str, List[Dict[str, Any]]] = collections.defaultdict(list)
    for archive in archives:
        archives_by_asset[asset_key_for_archive(archive)].append(archive)
    occurrence_asset: Dict[str, str] = {
        archive["archive"]: asset_key_for_archive(archive) for archive in archives
    }
    occurrences_by_asset: Dict[str, List[Dict[str, Any]]] = collections.defaultdict(list)
    for occurrence in occurrences:
        occurrences_by_asset[occurrence_asset[occurrence["archive"]]].append(occurrence)

    assets: List[Dict[str, Any]] = []
    for asset_id, group in sorted(archives_by_asset.items()):
        metadata = merge_metadata(
            summary
            for archive in group
            for summary in archive.get("metadata", [])
            if summary.get("kind") == "json"
        )
        variants = sorted(
            (
                {
                    "resolution": archive.get("resolution"),
                    "flavor": archive.get("flavor"),
                    "archive": archive["archive"],
                    "archive_bytes": archive["archive_bytes"],
                    "channels": archive["channels"],
                }
                for archive in group
            ),
            key=lambda item: (
                item["resolution"] or "",
                item["flavor"] or "",
                item["archive"],
            ),
        )
        duplicates = duplicate_payload_groups(occurrences_by_asset[asset_id])
        actual_dimensions = [
            [width, height]
            for width, height in sorted(
                {
                    (item["width"], item["height"])
                    for archive in group
                    for item in archive.get("image_dimensions", [])
                }
            )
        ]
        assets.append(
            {
                "asset_id": asset_id,
                "names": metadata["names"],
                "labels": sorted({str(archive["label"]) for archive in group}),
                "archive_count": len(group),
                "archive_bytes": sum(archive["archive_bytes"] for archive in group),
                "variants": variants,
                "channels_in_archives": sorted(
                    {channel for archive in group for channel in archive["channels"]}
                ),
                "actual_image_dimensions": actual_dimensions,
                "metadata": metadata,
                "duplicate_payload_groups": duplicates,
                "redundant_uncompressed_bytes_crc_size_evidence": sum(
                    item["redundant_uncompressed_bytes"] for item in duplicates
                ),
            }
        )
    return assets


def audit_library(root: Path, max_metadata_bytes: int) -> Dict[str, Any]:
    if not root.is_dir():
        raise FileNotFoundError(f"material library is not a directory: {root}")
    archive_paths = sorted(
        (path for path in root.iterdir() if path.is_file() and path.suffix.lower() == ".zip"),
        key=lambda path: path.name.lower(),
    )
    image_cache: Dict[Tuple[int, int, str], Optional[Tuple[int, int]]] = {}
    metadata_cache: Dict[Tuple[int, int], Tuple[Optional[Any], Optional[str]]] = {}
    archives: List[Dict[str, Any]] = []
    occurrences: List[Dict[str, Any]] = []
    for path in archive_paths:
        archive, archive_occurrences = audit_archive(
            path, image_cache, metadata_cache, max_metadata_bytes
        )
        archives.append(archive)
        occurrences.extend(archive_occurrences)
    assets = build_asset_summaries(archives, occurrences)
    suffix_counts: collections.Counter[str] = collections.Counter(
        occurrence["suffix"] for occurrence in occurrences
    )
    channel_counts: collections.Counter[str] = collections.Counter(
        occurrence["channel"]
        for occurrence in occurrences
        if occurrence.get("channel")
    )
    warning_count = sum(len(archive["warnings"]) for archive in archives)
    license_field_count = sum(
        len(metadata.get("license_fields", []))
        for archive in archives
        for metadata in archive.get("metadata", [])
    )
    return {
        "schema_version": SCRIPT_VERSION,
        "source": str(root.resolve()),
        "method": {
            "archive_access": "ZIP central directory only",
            "content_reads": (
                f"JSON/glTF members up to {max_metadata_bytes} bytes and image prefixes "
                f"up to {MAX_IMAGE_HEADER_BYTES} bytes"
            ),
            "archive_extraction": False,
            "full_payload_hashing": False,
            "duplicate_evidence": "ZIP CRC32 + uncompressed size; collision-safe hash not computed",
        },
        "totals": {
            "asset_count": len(assets),
            "archive_count": len(archives),
            "archive_bytes": sum(item["archive_bytes"] for item in archives),
            "entry_count": sum(item["entry_count"] for item in archives),
            "file_count": sum(item["file_count"] for item in archives),
            "compressed_payload_bytes": sum(
                item["compressed_payload_bytes"] for item in archives
            ),
            "uncompressed_payload_bytes": sum(
                item["uncompressed_payload_bytes"] for item in archives
            ),
            "formats": dict(sorted(suffix_counts.items())),
            "channels": dict(sorted(channel_counts.items())),
            "warning_count": warning_count,
            "license_field_count": license_field_count,
        },
        "assets": assets,
        "archives": archives,
    }


def display_name(asset: Dict[str, Any]) -> str:
    names = asset.get("names") or asset.get("labels") or [asset["asset_id"]]
    return str(names[0])


def format_variant(variant: Dict[str, Any]) -> str:
    resolution = variant.get("resolution") or "?"
    flavor = variant.get("flavor") or "unknown"
    return f"{resolution}/{flavor}"


def markdown_report(report: Dict[str, Any]) -> str:
    totals = report["totals"]
    lines = [
        "# Material library inventory",
        "",
        f"- Source: `{report['source']}`",
        (
            f"- Assets: {totals['asset_count']}; ZIP archives: {totals['archive_count']}; "
            f"archive bytes: {human_bytes(totals['archive_bytes'])}"
        ),
        (
            f"- ZIP payload: {human_bytes(totals['compressed_payload_bytes'])} compressed; "
            f"{human_bytes(totals['uncompressed_payload_bytes'])} uncompressed"
        ),
        (
            f"- Files: {totals['file_count']}; warnings: {totals['warning_count']}; "
            f"license-like metadata fields: {totals['license_field_count']}"
        ),
        (
            "- Read mode: central directories + bounded metadata/image headers; "
            "no extraction and no full payload hashing."
        ),
        "",
        "## Assets",
        "",
        "| ID | Name | Physical size | Tileable | Variants | Total ZIP size | Channels |",
        "| --- | --- | --- | --- | --- | ---: | --- |",
    ]
    for asset in report["assets"]:
        metadata = asset["metadata"]
        physical = ", ".join(str(item) for item in metadata["physical_sizes_m"]) or "unknown"
        tileable = ", ".join(str(item) for item in metadata["tileable"]) or "unknown"
        variants = ", ".join(format_variant(item) for item in asset["variants"])
        channels = ", ".join(asset["channels_in_archives"])
        lines.append(
            f"| `{asset['asset_id']}` | {display_name(asset)} | {physical} m | "
            f"{tileable} | {variants} | {human_bytes(asset['archive_bytes'])} | {channels} |"
        )
    lines.extend(["", "## Variant detail", ""])
    for asset in report["assets"]:
        lines.extend(
            [
                f"### {display_name(asset)} (`{asset['asset_id']}`)",
                "",
                (
                    "- Metadata channels: "
                    + (", ".join(asset["metadata"]["map_channels"]) or "none")
                ),
                (
                    "- Measured image dimensions: "
                    + (
                        ", ".join(
                            f"{width}×{height}"
                            for width, height in asset["actual_image_dimensions"]
                        )
                        or "none"
                    )
                ),
                (
                    "- License-like metadata fields: "
                    + str(len(asset["metadata"]["license_fields"]))
                ),
                (
                    "- CRC32+size duplicate payload estimate: "
                    + human_bytes(
                        asset["redundant_uncompressed_bytes_crc_size_evidence"]
                    )
                    + " redundant (not a cryptographic duplicate proof)"
                ),
                "",
            ]
        )
        for variant in asset["variants"]:
            lines.append(
                f"- `{variant['archive']}` — {format_variant(variant)}, "
                f"{human_bytes(variant['archive_bytes'])}, "
                f"{', '.join(variant['channels']) or 'no named texture channels'}"
            )
        lines.append("")
    if totals["warning_count"]:
        lines.extend(["## Warnings", ""])
        for archive in report["archives"]:
            for warning in archive["warnings"]:
                lines.append(f"- `{archive['archive']}`: {warning}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "library",
        nargs="?",
        type=Path,
        default=DEFAULT_LIBRARY,
        help=f"directory containing ZIP archives (default: {DEFAULT_LIBRARY})",
    )
    parser.add_argument(
        "--format",
        choices=("markdown", "json"),
        default="markdown",
        help="stdout format (default: markdown)",
    )
    parser.add_argument(
        "--max-metadata-bytes",
        type=int,
        default=DEFAULT_MAX_METADATA_BYTES,
        help="maximum bytes read from each JSON/glTF member",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    if args.max_metadata_bytes <= 0:
        print("--max-metadata-bytes must be positive", file=sys.stderr)
        return 2
    try:
        report = audit_library(args.library, args.max_metadata_bytes)
    except (FileNotFoundError, PermissionError, OSError) as error:
        print(f"audit failed: {error}", file=sys.stderr)
        return 1
    if args.format == "json":
        json.dump(report, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(markdown_report(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
