#!/usr/bin/env python3
"""Build catalog.json with local SHA-256 hashes for this acquisition batch."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
OUT = HERE / "catalog.json"


def rel(path: str | None) -> str | None:
    return None if path is None else str(resolve_local(path).relative_to(REPO))


def sha256(path: str | None) -> str | None:
    if path is None:
        return None
    target = resolve_local(path)
    if not target.is_file():
        return None
    digest = hashlib.sha256()
    with target.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def resolve_local(path: str) -> Path:
    """Resolve a source artifact name below raw/ unless a subdirectory is given."""
    target = HERE / path
    if not target.exists() and "/" not in path:
        target = HERE / "raw" / path
    return target


def item(
    url: str,
    title: str,
    kind: str,
    local: str | None,
    license_text: str,
    status: str,
    notes: str,
    extracted: str | None = None,
) -> dict[str, object]:
    return {
        "url": url,
        "title": title,
        "type": kind,
        "local_path": rel(local),
        "license": license_text,
        "status": status,
        "notes": notes,
        "hash": sha256(local),
        **({"extracted_path": rel(extracted)} if extracted else {}),
    }


def main() -> None:
    sources = [
        item(
            "https://pole.se/product/lamborghini-aventador-2014/",
            "Pole Position Production — Lamborghini Aventador 2014 product page",
            "product-page",
            "pole-lamborghini-product.html",
            "Pole EULA; product page states Royalty-free Single User License",
            "DOWNLOADED_PUBLIC",
            "Direct page: Complete Library USD 249 / 286 clips / 31.4 GB; Spotting Files USD 99 / 83 files / 839 MB; Italian 2014 LP 700-4, 96 kHz/24-bit. LISTENING_NOT_RUN.",
        ),
        item(
            "https://pole.se/wp-content/uploads/2024/01/Lamborghini-Aventador-Sound-File-List.pdf",
            "Pole Lamborghini Aventador complete file list",
            "file-list-pdf",
            "pole-lamborghini-complete-filelist.pdf",
            "Metadata/file list only; audio use is governed by Pole EULA",
            "DOWNLOADED_PUBLIC",
            "PDF contains 286 .wav rows; extracted aggregate duration 18:15:00.099. Rows explicitly describe Italian 2014 Lamborghini Aventador LP 700-4 Coupe. LISTENING_NOT_RUN.",
            "extracted/pole-lamborghini-complete-filelist.txt",
        ),
        item(
            "https://pole.se/wp-content/uploads/2019/01/Lamborghini-Aventador-Sound-File-List-Spotting-v2.pdf",
            "Pole Lamborghini Aventador spotting file list v2",
            "file-list-pdf",
            "pole-lamborghini-spotting-v2.pdf",
            "Metadata/file list only; audio use is governed by Pole EULA",
            "DOWNLOADED_PUBLIC",
            "PDF contains 83 .wav rows; extracted aggregate duration 00:23:10.996. Product page describes this as the Spotting Files variant. LISTENING_NOT_RUN.",
            "extracted/pole-lamborghini-spotting-v2.txt",
        ),
        item(
            "https://pole.se/shop/eula/",
            "Pole Position Production EULA page",
            "license-html",
            "pole-eula.html",
            "Pole Position Production EULA",
            "DOWNLOADED_PUBLIC",
            "Worldwide, non-exclusive, royalty-free license; unlimited lifetime projects; personal/commercial use without attribution; one local drive plus one backup; no network/share; single-user unless multi-user license; no AI training. See also PDF copy.",
        ),
        item(
            "https://drive.usercontent.google.com/download?id=1dN-yVRuu7MV0X1jxt9rzYz-Ru7UkiF5P&export=download&confirm=t",
            "Pole Position Production EULA PDF copy",
            "license-pdf",
            "pole-eula.pdf",
            "Pole Position Production EULA",
            "DOWNLOADED_PUBLIC",
            "Public PDF linked from the EULA page; extracted text kept for audit. LISTENING_NOT_RUN.",
            "extracted/pole-eula.txt",
        ),
        item(
            "https://soundcloud.com/polepositionproduction/sets/lamborghini-aventador-sound-library-audio-demo-preview-montage",
            "Pole Lamborghini Aventador SoundCloud audio demo preview montage",
            "streaming-preview",
            None,
            "All-rights-reserved as displayed by SoundCloud; no download license identified",
            "STREAM_ONLY",
            "Public stream page lists five preview tracks and points back to the Pole product page. No explicit author download link was identified; stream only, no extraction or bypass. LISTENING_NOT_RUN.",
        ),
        item(
            "https://sonniss.com/sound-effects/lamborghini-aventador-2014/",
            "SONNISS — Lamborghini Aventador 2014 product page",
            "product-page",
            None,
            "Sonniss EULA; licensed, not sold; royalty-free after purchase",
            "VERIFIED_WEB_NO_LOCAL_COPY",
            "Web page reports USD 249, 366 files, 27.48 GB, 96 kHz/24-bit, sold by Pole Position; page and CDN tracklist conflict with Pole direct 286 files/31.4 GB. LISTENING_NOT_RUN.",
        ),
        item(
            "https://cdn.sonniss.com/storage/2025/02/Lamborghini-Aventador-2014-Sheet1.pdf",
            "SONNISS — Lamborghini Aventador 2014 tracklist",
            "file-list-pdf",
            "sonniss-lamborghini-tracklist.pdf",
            "Metadata/file list only; audio use is governed by Sonniss EULA",
            "DOWNLOADED_PUBLIC",
            "PDF contains 366 .wav rows; extracted aggregate duration 16:07:38.000. Treat as a separate listing claim; do not reconcile to Pole's 286/31.4 GB claim. LISTENING_NOT_RUN.",
            "extracted/sonniss-lamborghini-tracklist.txt",
        ),
        item(
            "https://sonniss.com/license/",
            "SONNISS sound library license",
            "license-page",
            None,
            "Sonniss EULA",
            "VERIFIED_WEB_NO_LOCAL_COPY",
            "Worldwide, non-exclusive, royalty-free after purchase; unlimited lifetime projects; commercial/personal use without attribution; one local drive plus one backup; no network/share; no AI training; single-user unless site/multi-user license.",
        ),
        item(
            "https://www.sweetsfx.com/product/porsche-992-gt3/",
            "Sweet SFX — Porsche 992 GT3 product page",
            "product-page",
            "sweetsfx-p992gt3-product.html",
            "Sounding Sweet EULA; product page variants are licensed, not sold",
            "DOWNLOADED_PUBLIC",
            "Correct product found through www.sweetsfx.com navigation/search. Short & Sweet GBP 79 excluding VAT; Standard Pack GBP 199 excluding VAT; Ultimate says call for price. Source is stock 4.0L F6 manual GT3; never label as GT3 RS or PDK. LISTENING_NOT_RUN.",
        ),
        item(
            "https://www.sweetsfx.com/wp-content/uploads/2026/02/SSFX-P992GT3_Standard_FileList.pdf",
            "Sweet SFX Porsche 992 GT3 Standard Pack file list",
            "file-list-pdf",
            "sweetsfx-p992gt3-standard-filelist.pdf",
            "Metadata/file list only; audio use is governed by Sounding Sweet EULA",
            "DOWNLOADED_PUBLIC",
            "233 .wav rows; extracted aggregate duration 03:27:21.000. Product specs: 7.89 GB compressed, 8.42 GB uncompressed, 96 kHz/24-bit; ambisonic surround and Reaper/Pro Tools sessions are described for the standard pack. LISTENING_NOT_RUN.",
            "extracted/sweetsfx-p992gt3-standard-filelist.txt",
        ),
        item(
            "https://www.sweetsfx.com/wp-content/uploads/2026/02/SSFX-P992GT3_Short_and_Sweet_FileList.pdf",
            "Sweet SFX Porsche 992 GT3 Short & Sweet file list",
            "file-list-pdf",
            "sweetsfx-p992gt3-short-and-sweet-filelist.pdf",
            "Metadata/file list only; audio use is governed by Sounding Sweet EULA",
            "DOWNLOADED_PUBLIC",
            "Correct URL includes the SSFX-P992GT3 prefix. 52 .wav rows; extracted aggregate duration 00:46:13.000. Product specs: 1.37 GB compressed, 1.46 GB uncompressed; no surround files in Short & Sweet. LISTENING_NOT_RUN.",
            "extracted/sweetsfx-p992gt3-short-and-sweet-filelist.txt",
        ),
        item(
            "https://www.sweetsfx.com/licensing/",
            "Sounding Sweet / Sweet SFX EULA",
            "license-html",
            "sweetsfx-licensing.html",
            "Sounding Sweet Limited EULA",
            "DOWNLOADED_PUBLIC",
            "Non-exclusive and non-transferable license for the Order Form workstations/users; rights after full fee; 99-year initial term with renewal; may embed/adapt in games and other Products; no standalone resale, sharing, extraction, or third-party sound-library redistribution; one backup only with written consent. Free-pack applicability is not expressly stated.",
        ),
        item(
            "https://www.sweetsfx.com/product/sweet-sfx-free-sample-volume-one/",
            "Sweet SFX Free Sample Volume One product page",
            "free-sample-product-page",
            "sweetsfx-free-sample-product.html",
            "Price shown as GBP 0.00; separate free-sample terms are not stated on the product page",
            "PUBLIC_FREE_LISTING_NO_DIRECT_AUDIO",
            "Product page identifies 99 WAV files, 2.2 GB compressed / 2.4 GB uncompressed, download-only, price GBP 0.00. No direct public audio URL was exposed; full pack exceeds 200 MB cap, so no audio archive was fetched. File-list PDF saved. LISTENING_NOT_RUN.",
        ),
        item(
            "https://www.sweetsfx.com/wp-content/uploads/2025/11/SSFX-Free_Pack_FileList.pdf",
            "Sweet SFX Free Pack file list",
            "file-list-pdf",
            "sweetsfx-free-pack-filelist.pdf",
            "Metadata/file list only; free-pack audio terms not expressly stated",
            "DOWNLOADED_PUBLIC",
            "Two-page public file list for the 99-file free pack; it contains filenames/metadata but no durations. No audio archive downloaded because the product page states 2.2 GB compressed. LISTENING_NOT_RUN.",
            "extracted/sweetsfx-free-pack-filelist.txt",
        ),
        item(
            "https://sonniss.com/sound-effects/mazda-miata-mx5-nbfl-1-6-stock/",
            "SONNISS — Mazda Miata MX5 NBFL 1.6 Stock product page",
            "product-page",
            None,
            "Sonniss EULA; licensed, not sold; royalty-free after purchase",
            "VERIFIED_WEB_NO_LOCAL_COPY",
            "Seller shown as soundholder. Direct product page value observed as USD 70; category/listing cache also showed a USD 49 sale value, so price should be rechecked at checkout. 149 files / 4.63 GB / 96 kHz/24-bit / 232 min. NBFL 1.6 is a cross-generation reference and must not be called NA. LISTENING_NOT_RUN.",
        ),
        item(
            "https://cdn.sonniss.com/storage/2025/02/Mazda-Miata-MX5-NBFL-1.6-Stock-Sheet1.pdf",
            "SONNISS — Mazda Miata MX5 NBFL 1.6 Stock tracklist",
            "file-list-pdf",
            "sonniss-miata-tracklist.pdf",
            "Metadata/file list only; audio use is governed by Sonniss EULA",
            "DOWNLOADED_PUBLIC",
            "PDF contains 149 .wav rows; extracted aggregate duration 03:52:34.000, matching the product page's approximately 232 minutes. LISTENING_NOT_RUN.",
            "extracted/sonniss-miata-tracklist.txt",
        ),
        item(
            "https://sonniss.com/vendors/soundholder/",
            "SONNISS soundholder vendor page",
            "vendor-page",
            None,
            "Sonniss EULA for Sonniss purchases",
            "VERIFIED_WEB_NO_LOCAL_COPY",
            "Vendor page confirms soundholder as a Sonniss seller; the Miata listing is reached through the product page rather than a separate downloadable origin. LISTENING_NOT_RUN.",
        ),
        item(
            "https://soundholder.com/",
            "Soundholder official domain",
            "origin-page",
            None,
            "No license text recovered from the origin page",
            "BROKEN_SERVER",
            "Public domain resolves but currently returns a PHP fatal error for a missing WordPress theme file; no product page or license could be verified there. Use the Sonniss listing for the purchasable NBFL library. LISTENING_NOT_RUN.",
        ),
        item(
            "https://freesound.org/people/TurboTheSergal/sounds/523351/",
            "Freesound — Miata Start and Stop.mp3",
            "sound-page",
            "freesound-523351-page.html",
            "CC BY 4.0 (Attribution 4.0)",
            "DOWNLOADED_PUBLIC",
            "Page metadata: posted 2020-06-22; Mazda MX5/Miata startup and engine stop from inside; 0:13.881, 544.9 KB, 44.1 kHz, 320 kbps, mono. Vehicle year/generation unknown. LISTENING_NOT_RUN.",
        ),
        item(
            "https://freesound.org/people/TurboTheSergal/sounds/523351/download/523351__turbothesergal__miata-start-and-stop.mp3",
            "Freesound original MP3 download endpoint",
            "original-audio-download",
            None,
            "CC BY 4.0",
            "BLOCKED_LOGIN",
            "Normal HEAD request redirects to /home/login/; no login, captcha, or access-control bypass attempted. Manual step: sign in on the sound page, then use its Download button if the user has an account. LISTENING_NOT_RUN.",
        ),
        item(
            "https://cdn.freesound.org/previews/523/523351_11603686-hq.mp3",
            "Freesound public HQ preview",
            "preview-audio",
            "freesound-523351-preview-hq.mp3",
            "CC BY 4.0 page license; file is a transcoded preview",
            "PREVIEW_ONLY",
            "Public preview fetched from the page's static-file URL. It is not the original download; ffprobe reports about 186.9 kbps average MPEG audio (stream 186360 bps; format 186925 bps; possibly VBR), 44.1 kHz mono, about 13.881 s. Do not treat as original. LISTENING_NOT_RUN.",
        ),
        item(
            "https://creativecommons.org/licenses/by/4.0/",
            "Creative Commons Attribution 4.0 license",
            "license-page",
            None,
            "CC BY 4.0",
            "VERIFIED_WEB_NO_LOCAL_COPY",
            "Freesound page links this license and states sharing/remixing are allowed with attribution. Verify attribution text on the source page before publication.",
        ),
    ]

    payload = {
        "schema": "streetrush.audio-acquisition.v1",
        "captured_at": "2026-09-07",
        "scope": "independent vehicle sound research; no game/physics integration",
        "download_cap_bytes": 200_000_000,
        "listening": "LISTENING_NOT_RUN",
        "sources": sources,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT}")
    print(f"sources={len(sources)}")
    local_paths = [s["local_path"] for s in sources if s["local_path"]]
    def source_path(path: str) -> Path:
        return REPO / path if path.startswith("research-output/") else resolve_local(path)

    print(f"downloaded_bytes={sum(source_path(p).stat().st_size for p in local_paths)}")


if __name__ == "__main__":
    main()
