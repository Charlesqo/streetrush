#!/usr/bin/env python3
"""Build manifest.json + previews/ + index.html for the StreetRush material preview library.

Reads the safely-extracted 1K UE material sets under extracted/, classifies maps via
the authoritative glTF bindings inside each set, copies role-named previews, and
emits index.html with the data inlined (file:// friendly, no network, no fetch).

Python 3.9 compatible. Idempotent: safe to re-run.
"""
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = "/Volumes/Charles/下载/赛车游戏 材质"

DISCLAIMER = (
    "颜色图预览只是底色贴图的原始像素副本，未参与法线/粗糙度/位移渲染，"
    "不代表完整材质的最终外观；请以游戏内实测为准。"
)

# Display metadata per set (category / suggested use are editorial choices for the next round)
SETS = [
    {
        "zip": "road_asphalt_rh0ribp0_1k_ue_low.zip",
        "displayNameCn": "道路沥青",
        "category": "道路",
        "suggestedUse": "路面主体候选：干净平铺沥青（物理尺寸 0.39x0.39m，tileable）",
    },
    {
        "zip": "asphalt_crack_ugcmfivcw_1k_ue_low.zip",
        "displayNameCn": "沥青裂纹贴花",
        "category": "道路",
        "suggestedUse": "道路裂纹 overlay/贴花候选：带透明通道（BLEND），源数据分类为 decal/atlas，tileable=false",
    },
    {
        "zip": "cracked_asphalt_tjmgfelew_1k_ue_low.zip",
        "category": "道路",
        "displayNameCn": "开裂沥青",
        "suggestedUse": "破损路面整体替换候选（平铺 2x2m，tileable）",
    },
    {
        "zip": "lawn_grass_tkynejer_1k_ue_low.zip",
        "category": "草地",
        "displayNameCn": "草坪草地",
        "suggestedUse": "路侧/缓冲区草地候选（平铺 2x2m，tileable）",
    },
]

# role key -> (role label CN, channels, channel meaning, confirmation, optional note)
ROLE_INFO = {
    "baseColor": (
        "颜色/底色 (baseColor)",
        "RGB",
        "RGB=底色，sRGB 色彩空间",
        "已确认：gltf 的 baseColorTexture 绑定到此文件",
        "",
    ),
    "baseColorOpacity": (
        "颜色+不透明度 (baseColor+opacity)",
        "RGBA",
        "RGB=底色(sRGB)，A=不透明度",
        "已确认：gltf baseColorTexture 绑定 + alphaMode=BLEND + 文件后缀 -O + 实测 PNG 含 alpha 通道",
        "",
    ),
    "normal": (
        "法线 (normal)",
        "RGB",
        "切线空间法线；glTF 2.0 约定 OpenGL 风格（+Y 向上）",
        "已确认：gltf 的 normalTexture 绑定到此文件；+Y 向上为 glTF 2.0 规范约定",
        "使用注意：UE 原生法线为 DirectX 风格（-Y）。经 glTF 导入器/UE 插件流程会自动处理；若手动贴图需确认 G 通道是否要翻转——未实测，导入时请复核。",
    ),
    "orm": (
        "AO+粗糙度+金属度打包 (ORM)",
        "R/G/B",
        "R=AO 遮挡，G=粗糙度，B=金属度（glTF 2.0 metallicRoughness/occlusion 约定）",
        "已确认：gltf 中 occlusionTexture 与 metallicRoughnessTexture 指向同一张图，符合 glTF 2.0 ORM 打包约定",
        "使用注意：ORM 以 JPEG 存储，三通道数据可能存在压缩串扰；对粗糙度敏感的表面建议检查 G 通道——未实测。",
    ),
}

SUFFIX_TO_ROLE = [("_B-O", "baseColorOpacity"), ("_B", "baseColor"), ("_N", "normal"), ("_ORM", "orm")]
PREVIEW_PREFIX = {
    "baseColor": "basecolor",
    "baseColorOpacity": "basecolor-opacity",
    "normal": "normal",
    "orm": "orm-ao-rough-metal",
}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def image_info(path):
    """Return (width, height, hasAlpha, format) via sips, or '未确认' on failure."""
    try:
        out = subprocess.run(
            ["sips", "-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", path],
            capture_output=True, text=True, timeout=30,
        ).stdout
        w = re.search(r"pixelWidth:\s*(\d+)", out)
        h = re.search(r"pixelHeight:\s*(\d+)", out)
        a = re.search(r"hasAlpha:\s*(\w+)", out)
        fmt = "PNG" if path.lower().endswith(".png") else ("JPEG" if path.lower().endswith((".jpg", ".jpeg")) else "未确认")
        return (
            int(w.group(1)) if w else "未确认",
            int(h.group(1)) if h else "未确认",
            (a.group(1) == "yes") if a else "未确认",
            fmt,
        )
    except Exception:
        return ("未确认", "未确认", "未确认", "未确认")


def classify(filename):
    """Classify a texture filename into a role, or None."""
    stem = os.path.splitext(os.path.basename(filename))[0]
    for suf, role in SUFFIX_TO_ROLE:
        if stem.endswith(suf):
            return role
    return None


def read_meta(set_dir):
    """Parse the PolyHaven-style metadata json shipped in the zip."""
    js = glob.glob(os.path.join(set_dir, "*.json"))
    out = {}
    if not js:
        return out
    with open(js[0], encoding="utf-8") as f:
        d = json.load(f)
    props = {}
    for p in d.get("meta", []):
        if isinstance(p, dict) and "key" in p:
            props[p["key"]] = p.get("value")
    out.update(
        {
            "sourceName": d.get("name"),
            "sourceId": d.get("id"),
            "averageColor": d.get("averageColor"),
            "categories": d.get("categories"),
            "tags": d.get("tags"),
            "highestAvailableRes": d.get("highest_available_res"),
            "scanArea": props.get("scanArea"),
            "tileable": props.get("tileable"),
            "texelDensity": props.get("texelDensity"),
            "height": props.get("height"),
        }
    )
    return out


def read_gltf(set_dir):
    g = glob.glob(os.path.join(set_dir, "*.gltf"))
    if not g:
        return None
    with open(g[0], encoding="utf-8") as f:
        d = json.load(f)
    mat = (d.get("materials") or [{}])[0]
    uris = [img.get("uri") for img in d.get("images", [])]
    pbr = mat.get("pbrMetallicRoughness", {})
    binds = {}
    if "normalTexture" in mat:
        binds["normalTexture"] = uris[mat["normalTexture"]["index"]]
    if "occlusionTexture" in mat:
        binds["occlusionTexture"] = uris[mat["occlusionTexture"]["index"]]
    if "baseColorTexture" in pbr:
        binds["baseColorTexture"] = uris[pbr["baseColorTexture"]["index"]]
    if "metallicRoughnessTexture" in pbr:
        binds["metallicRoughnessTexture"] = uris[pbr["metallicRoughnessTexture"]["index"]]
    return {
        "gltfPath": os.path.relpath(g[0], ROOT),
        "materialName": mat.get("name"),
        "alphaMode": mat.get("alphaMode", "OPAQUE"),
        "bindings": binds,
        "images": uris,
    }


def build_set(entry, manifest):
    setname = entry["zip"][:-4]
    set_dir = os.path.join(ROOT, "extracted", setname)
    zip_path = os.path.join(SRC_DIR, entry["zip"])
    rel = lambda p: os.path.relpath(p, ROOT).replace(os.sep, "/")

    gltf = read_gltf(set_dir)
    meta = read_meta(set_dir)
    sid = meta.get("sourceId") or setname.split("_")[2]

    maps = []
    tex_files = sorted(glob.glob(os.path.join(set_dir, "Textures", "*")))
    for tf in tex_files:
        role = classify(tf)
        if role is None:
            maps.append(
                {
                    "role": "unknown",
                    "roleCn": "未确认角色",
                    "original": rel(tf),
                    "confirmed": "未确认：文件名后缀无法识别，请人工核对",
                    "width": image_info(tf)[0],
                    "height": image_info(tf)[1],
                }
            )
            continue
        label, channels, meaning, confirmed, note = ROLE_INFO[role]
        w, h, has_alpha, fmt = image_info(tf)
        pv_dir = os.path.join(ROOT, "previews", setname)
        os.makedirs(pv_dir, exist_ok=True)
        pv = os.path.join(pv_dir, "%s__%s" % (PREVIEW_PREFIX[role], os.path.basename(tf)))
        shutil.copy2(tf, pv)
        maps.append(
            {
                "role": role,
                "roleCn": label,
                "original": rel(tf),
                "preview": rel(pv),
                "format": fmt,
                "width": w,
                "height": h,
                "channels": channels,
                "channelMeaning": meaning,
                "confirmed": confirmed,
                "note": note,
                "hasAlpha": has_alpha,
            }
        )
    maps.sort(key=lambda m: ["baseColor", "baseColorOpacity", "normal", "orm", "unknown"].index(m["role"]) if m["role"] in PREVIEW_PREFIX else 99)

    # sibling (higher-res) zips, recorded for the next round, never extracted
    siblings = []
    for zp in sorted(glob.glob(os.path.join(SRC_DIR, "%s_*.zip" % sid))):
        zn = os.path.basename(zp)
        note = "本次选用" if zn == entry["zip"] else "未解压，备用"
        siblings.append({"file": zn, "path": zp, "sizeBytes": os.path.getsize(zp), "note": note})

    # missing / unconfirmed items
    missing = [
        "独立粗糙度贴图缺失（打包于 ORM 的 G 通道）",
        "独立 AO 贴图缺失（打包于 ORM 的 R 通道）",
        "独立金属度贴图缺失（打包于 ORM 的 B 通道）",
        "高度/位移贴图缺失（本 1k_ue_low 档不含 Height/Displacement）",
        "许可未确认：元数据 JSON 无 license 字段，本次未联网核实（格式特征指向 PolyHaven，其默认许可为 CC0，但未经证实，入库游戏前必须核实）",
    ]
    if entry["category"] == "道路" and gltf and gltf["alphaMode"] == "OPAQUE":
        missing.append("不透明度贴图缺失（材质为 OPAQUE，一般不构成问题）")
    avg = meta.get("averageColor")
    avg_status = "已确认（源自元数据）"
    if avg in (None, "#000000"):
        avg_status = "未确认：元数据 averageColor 为 %s，疑似透明区域/图集导致平均色失效" % avg

    record = {
        "setName": setname,
        "sourceId": sid,
        "displayNameCn": entry["displayNameCn"],
        "displayName": meta.get("sourceName"),
        "category": entry["category"],
        "suggestedUse": entry["suggestedUse"],
        "originalZip": {
            "path": zip_path,
            "sizeBytes": os.path.getsize(zip_path),
            "sha256": sha256(zip_path),
        },
        "siblingZips": siblings,
        "extractedDir": rel(set_dir),
        "material": gltf,
        "meta": meta,
        "averageColorStatus": avg_status,
        "selectedMaps": maps,
        "missing": missing,
        "processedAt": datetime.now().isoformat(timespec="seconds"),
    }
    manifest["sets"] = [s for s in manifest["sets"] if s["setName"] != setname] + [record]
    manifest["sets"].sort(key=lambda s: [e["zip"][:-4] for e in SETS].index(s["setName"]))
    # save after every set so an interruption never loses progress
    with open(os.path.join(ROOT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print("  set done: %s (%d maps)" % (setname, len(maps)))
    return record


def build_index(manifest):
    data = {
        "generatedAt": manifest["generatedAt"],
        "sourceDir": SRC_DIR,
        "disclaimer": DISCLAIMER,
        "sets": manifest["sets"],
    }
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    page = HTML_TEMPLATE.replace("__PAYLOAD__", payload)
    with open(os.path.join(ROOT, "index.html"), "w", encoding="utf-8") as f:
        f.write(page)
    print("index.html written")


def main():
    manifest = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "generator": "scratch/glm-materials-20260905-084701/tools/build.py（人工运行，无网络、无第三方依赖）",
        "sourceDir": SRC_DIR,
        "sourceDirPolicy": "只读，未修改",
        "disclaimer": DISCLAIMER,
        "licenseStatus": "未确认：所有元数据 JSON 均无 license 字段；未联网核实前不得入库游戏",
        "missingCategories": [
            "混凝土：源目录无任何混凝土候选包（目录内仅 road_asphalt / asphalt_crack / cracked_asphalt / lawn_grass 四种材质的多分辨率档）",
        ],
        "sets": [],
    }
    for entry in SETS:
        build_set(entry, manifest)
    manifest["generatedAt"] = datetime.now().isoformat(timespec="seconds")
    with open(os.path.join(ROOT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    build_index(manifest)
    print("manifest.json + index.html done, %d sets" % len(manifest["sets"]))


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StreetRush 材质预览库</title>
<style>
:root{--bg:#141518;--panel:#1d1f24;--panel2:#25282f;--line:#33363e;--txt:#e8e6e1;--dim:#9aa0a8;--acc:#e8b93e;--ok:#69c17a;--warn:#e0a23c;--mono:ui-monospace,Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.55 -apple-system,"PingFang SC","Segoe UI",sans-serif}
header{padding:28px 24px 10px;max-width:1200px;margin:0 auto}
h1{font-size:26px;margin:0 0 4px}
h1 small{color:var(--acc);font-size:13px;font-weight:600;letter-spacing:1px;vertical-align:middle}
.sub{color:var(--dim);font-size:13px}
.sub code{font-family:var(--mono);font-size:12px;background:var(--panel2);padding:1px 6px;border-radius:4px}
.disclaimer{max-width:1200px;margin:14px auto 0;padding:10px 14px;background:#3a2f14;border:1px solid #6b5518;border-radius:8px;color:#f0d08a;font-size:13.5px}
.wrap{max-width:1200px;margin:0 auto;padding:16px 24px 120px}
.toolbar{display:flex;gap:8px;align-items:center;margin:18px 0 14px;flex-wrap:wrap}
.chip{cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--txt);border-radius:999px;padding:5px 14px;font-size:13.5px}
.chip.on{background:var(--acc);border-color:var(--acc);color:#141518;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.card .imgbox{position:relative;aspect-ratio:1/1;background:#0c0d0f}
.card .imgbox img{width:100%;height:100%;object-fit:cover;display:block}
.cat{position:absolute;top:10px;left:10px;background:rgba(0,0,0,.65);color:#fff;font-size:12px;padding:2px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.25)}
.alpha{position:absolute;top:10px;right:10px;background:rgba(120,30,30,.8);color:#fff;font-size:11.5px;padding:2px 8px;border-radius:999px}
.cbody{padding:12px 14px 14px;display:flex;flex-direction:column;gap:8px;flex:1}
.cname{font-size:17px;font-weight:600}
.cname span{color:var(--dim);font-weight:400;font-size:13px}
.mid{font-family:var(--mono);font-size:11.5px;color:var(--dim)}
.props{display:flex;flex-wrap:wrap;gap:6px}
.prop{font-size:12px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:2px 8px;color:var(--dim)}
.sw{display:inline-block;width:13px;height:13px;border-radius:3px;border:1px solid var(--line);vertical-align:-2px;margin-right:5px}
.avg{font-size:12.5px;color:var(--dim)}
.btns{display:flex;gap:8px;margin-top:auto}
button.act{flex:1;cursor:pointer;border:1px solid var(--line);background:var(--panel2);color:var(--txt);border-radius:8px;padding:8px 0;font-size:13.5px}
button.act:hover{border-color:var(--acc);color:var(--acc)}
button.act.sel{background:var(--acc);border-color:var(--acc);color:#141518;font-weight:600}
#cmpbar{position:fixed;left:0;right:0;bottom:0;background:var(--panel);border-top:1px solid var(--line);padding:12px 24px;display:none;align-items:center;gap:14px;z-index:40}
#cmpbar.show{display:flex}
#cmpnames{color:var(--dim);font-size:13px;flex:1}
.mask{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;z-index:50;overflow:auto;padding:30px 16px}
.mask.show{display:block}
.modal{max-width:980px;margin:0 auto;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px 24px 26px}
.modal h2{margin:0 0 2px;font-size:21px}
.modal .x{float:right;cursor:pointer;border:1px solid var(--line);background:var(--panel2);color:var(--txt);border-radius:8px;padding:4px 12px}
.maprow{display:flex;gap:16px;margin:16px 0;border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--panel2)}
.maprow img{width:200px;height:200px;object-fit:cover;border-radius:8px;flex:none;background:#0c0d0f}
.mrole{font-weight:600;font-size:15px}
.badge{display:inline-block;font-size:11.5px;border-radius:5px;padding:1px 8px;margin-left:8px;vertical-align:1px}
.badge.ok{background:rgba(105,193,122,.15);color:var(--ok);border:1px solid rgba(105,193,122,.4)}
.badge.warn{background:rgba(224,162,60,.14);color:var(--warn);border:1px solid rgba(224,162,60,.4)}
.mmeta{font-size:13px;color:var(--dim);margin-top:4px}
.mpath{font-family:var(--mono);font-size:11.5px;color:var(--dim);word-break:break-all;user-select:all;margin-top:5px}
.note{font-size:12.5px;color:var(--warn);margin-top:5px}
.zipinfo{margin-top:14px;border-top:1px dashed var(--line);padding-top:12px;font-size:13px}
.zipinfo .mpath{margin-top:3px}
h3.sect{margin:22px 0 8px;font-size:15px;color:var(--acc)}
ul.plain{margin:6px 0;padding-left:20px;font-size:13px;color:var(--dim)}
ul.plain li{margin:3px 0}
.cmpgrid{display:flex;gap:14px;flex-wrap:wrap;margin:14px 0}
.cmpcell{flex:1;min-width:220px}
.cmpcell img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:10px;background:#0c0d0f}
.cmpcell .t{text-align:center;font-weight:600;margin-top:6px}
table.facts{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:8px}
table.facts td,table.facts th{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
table.facts th{color:var(--dim);font-weight:500;background:var(--panel2);white-space:nowrap}
footer{max-width:1200px;margin:30px auto 0;padding:14px 24px;border-top:1px solid var(--line);color:var(--dim);font-size:12.5px}
</style>
</head>
<body>
<header>
  <h1><small>STREETRUSH</small> 材质预览库</h1>
  <div class="sub">生成时间 <span id="gen"></span> ｜ 素材源（只读）：<code id="srcdir"></code> ｜ 原始包路径与 SHA256 见各卡片「查看配套贴图」与 <code>manifest.json</code></div>
</header>
<div class="disclaimer" id="disclaimer"></div>
<div class="wrap">
  <div class="toolbar" id="filters"></div>
  <div class="grid" id="grid"></div>
  <footer>
    预览图 = <b>颜色贴图原始副本</b>（未修改像素）；配套法线 / ORM 贴图在「查看配套贴图」中查看。比较仅并排展示颜色图，不含光照渲染。
    通道含义与确认状态逐项标注：绿色「已确认」= 由包内 glTF 绑定或规范约定证实；黄色「未确认」= 需人工/联网核实。许可状态整体为<b>未确认</b>。
  </footer>
</div>
<div id="cmpbar"><div id="cmpnames"></div><button class="act" style="flex:0 0 auto;padding:8px 18px" onclick="openCompare()">对比所选</button><button class="act" style="flex:0 0 auto;padding:8px 18px" onclick="clearCompare()">清空</button></div>
<div class="mask" id="mask" onclick="if(event.target===this)closeModal()"><div class="modal" id="modal"></div></div>
<script id="material-data" type="application/json">__PAYLOAD__</script>
<script>
const DATA = JSON.parse(document.getElementById('material-data').textContent);
let filter='全部', cmp=[];
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const kb=b=>(b/1048576).toFixed(1)+' MB';
const sets=()=>DATA.sets.filter(s=>filter==='全部'||s.category===filter);
function colorMap(s){return s.selectedMaps.find(m=>m.role==='baseColorOpacity')||s.selectedMaps.find(m=>m.role==='baseColor')||{preview:''};}
function renderFilters(){
  const cats=['全部','道路','草地'];
  document.getElementById('filters').innerHTML=cats.map(c=>{
    const n=c==='全部'?DATA.sets.length:DATA.sets.filter(s=>s.category===c).length;
    return `<button class="chip ${filter===c?'on':''}" onclick="filter='${c}';renderFilters();renderGrid()">${c} (${n})</button>`;
  }).join('');
}
function renderGrid(){
  document.getElementById('grid').innerHTML=sets().map(s=>{
    const cm=colorMap(s), m=s.material||{}, meta=s.meta||{};
    const avg=meta.averageColor&&meta.averageColor!=='#000000'?meta.averageColor:null;
    return `<div class="card">
      <div class="imgbox"><img src="${esc(cm.preview)}" alt="${esc(s.displayNameCn)} 颜色贴图预览" loading="lazy">
        <span class="cat">${esc(s.category)}</span>
        ${m.alphaMode&&m.alphaMode!=='OPAQUE'?`<span class="alpha">${esc(m.alphaMode)} 透明</span>`:''}
      </div>
      <div class="cbody">
        <div class="cname">${esc(s.displayNameCn)} <span>${esc(s.displayName||'')}</span></div>
        <div class="mid">${esc(s.sourceId)} · ${esc(s.setName)}</div>
        <div class="props">
          ${meta.tileable===true?'<span class="prop">可平铺</span>':meta.tileable===false?'<span class="prop">不可平铺(贴花)</span>':''}
          ${meta.scanArea?`<span class="prop">物理尺寸 ${esc(meta.scanArea)}</span>`:''}
          <span class="prop">${esc(s.selectedMaps.length)} 张 1K 贴图</span>
          ${meta.highestAvailableRes?`<span class="prop">最高档 ${meta.highestAvailableRes}px</span>`:''}
        </div>
        <div class="avg">${avg?`<span class="sw" style="background:${esc(avg)}"></span>平均色 ${esc(avg)}（元数据）`:'<span class="sw" style="background:#333"></span>平均色未确认'}</div>
        <div class="btns">
          <button class="act" onclick="openDetail('${esc(s.setName)}')">查看配套贴图</button>
          <button class="act ${cmp.includes(s.setName)?'sel':''}" onclick="toggleCmp('${esc(s.setName)}')">${cmp.includes(s.setName)?'✓ 已选对比':'加入对比'}</button>
        </div>
      </div>
    </div>`;
  }).join('');
}
function toggleCmp(n){
  const i=cmp.indexOf(n);
  if(i>=0)cmp.splice(i,1);else if(cmp.length<4)cmp.push(n);
  renderCmpbar();renderGrid();
}
function clearCompare(){cmp=[];renderCmpbar();renderGrid();}
function renderCmpbar(){
  const bar=document.getElementById('cmpbar');
  bar.classList.toggle('show',cmp.length>0);
  document.getElementById('cmpnames').textContent=cmp.length?`已选 ${cmp.length} 套：`+cmp.map(n=>DATA.sets.find(s=>s.setName===n).displayNameCn).join(' · '):'';
}
function getSet(n){return DATA.sets.find(s=>s.setName===n);}
function openDetail(n){
  const s=getSet(n),m=s.material||{},meta=s.meta||{},z=s.originalZip;
  const maps=s.selectedMaps.map(mp=>`
    <div class="maprow">
      <img src="${esc(mp.preview||mp.original)}" alt="${esc(mp.roleCn)}" loading="lazy">
      <div style="flex:1;min-width:0">
        <div class="mrole">${esc(mp.roleCn)}<span class="badge ${mp.confirmed&&mp.confirmed.startsWith('已确认')?'ok':'warn'}">${mp.confirmed&&mp.confirmed.startsWith('已确认')?'已确认':'未确认'}</span></div>
        <div class="mmeta">${esc(mp.width||'?')}×${esc(mp.height||'?')} ${esc(mp.format||'')} · 通道 ${esc(mp.channels||'未确认')}：${esc(mp.channelMeaning||'未确认')}</div>
        <div class="mpath">${esc(mp.original)}</div>
        ${mp.note?`<div class="note">⚠ ${esc(mp.note)}</div>`:''}
        <div class="mpath">确认依据：${esc(mp.confirmed||'未确认')}</div>
      </div>
    </div>`).join('');
  const sib=(s.siblingZips||[]).map(x=>`<tr><td style="font-family:var(--mono);font-size:11.5px">${esc(x.file)}</td><td>${kb(x.sizeBytes)}</td><td>${esc(x.note)}</td></tr>`).join('');
  document.getElementById('modal').innerHTML=`
    <button class="x" onclick="closeModal()">关闭 ✕</button>
    <h2>${esc(s.displayNameCn)} <span style="color:var(--dim);font-size:14px;font-weight:400">${esc(s.displayName||'')}（id: ${esc(s.sourceId)}）</span></h2>
    <div class="mid">${esc(s.category)} · ${esc(s.suggestedUse)}</div>
    <h3 class="sect">本套 ${s.selectedMaps.length} 张 1K 贴图（1024×1024，取自 1k_ue_low 档）</h3>
    ${maps}
    <div class="zipinfo">
      <b>原始 ZIP</b>（${kb(z.sizeBytes)}）：<div class="mpath">${esc(z.path)}</div>
      SHA256：<div class="mpath">${esc(z.sha256)}</div>
      glTF 材质：<span class="mpath" style="display:inline">${esc(m.materialName||'未确认')}</span> · alphaMode: ${esc(m.alphaMode||'未确认')} · 绑定来源：<span class="mpath" style="display:inline">${esc(m.gltfPath||'未确认')}</span>
      <h3 class="sect">同素材其他分辨率档（仅记录，未解压）</h3>
      <table class="facts"><tr><th>文件</th><th>大小</th><th>状态</th></tr>${sib}</table>
      <h3 class="sect">缺失 / 未确认</h3>
      <ul class="plain">${s.missing.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>
      ${meta.tags?`<h3 class="sect">源数据标签</h3><div class="props">${meta.tags.map(t=>`<span class="prop">${esc(t)}</span>`).join('')}</div>`:''}
    </div>`;
  document.getElementById('mask').classList.add('show');
}
function openCompare(){
  if(cmp.length<2)return;
  const chosen=cmp.map(getSet);
  const cells=chosen.map(s=>`<div class="cmpcell"><img src="${esc(colorMap(s).preview)}" loading="lazy"><div class="t">${esc(s.displayNameCn)}</div></div>`).join('');
  const row=(label,fn)=>`<tr><th>${label}</th>${chosen.map(s=>`<td>${fn(s)}</td>`).join('')}</tr>`;
  document.getElementById('modal').innerHTML=`
    <button class="x" onclick="closeModal()">关闭 ✕</button>
    <h2>候选对比 <span style="color:var(--dim);font-size:14px;font-weight:400">仅并排展示颜色贴图，不代表完整材质渲染效果</span></h2>
    <div class="cmpgrid">${cells}</div>
    <table class="facts">
      ${row('类别',s=>esc(s.category))}
      ${row('建议用途',s=>esc(s.suggestedUse))}
      ${row('平均色(元数据)',s=>{const a=s.meta.averageColor;return (a&&a!=='#000000')?`<span class="sw" style="background:${esc(a)}"></span>${esc(a)}`:'未确认';})}
      ${row('物理尺寸',s=>esc(s.meta.scanArea||'未确认'))}
      ${row('可平铺',s=>s.meta.tileable===true?'是':s.meta.tileable===false?'否（贴花）':'未确认')}
      ${row('alphaMode',s=>esc(s.material.alphaMode||'未确认'))}
      ${row('1K 贴图',s=>esc(s.selectedMaps.map(m=>m.role).join(' / ')))}
      ${row('原包',s=>`${kb(s.originalZip.sizeBytes)} · <span class="mpath" style="display:inline">${esc(s.originalZip.path)}</span>`)}
      ${row('更高分辨率档',s=>esc(s.siblingZips.filter(x=>x.note!=='本次选用').map(x=>x.file).join('、')))}
    </table>`;
  document.getElementById('mask').classList.add('show');
}
function closeModal(){document.getElementById('mask').classList.remove('show');}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal();}});
document.getElementById('gen').textContent=DATA.generatedAt;
document.getElementById('srcdir').textContent=DATA.sourceDir;
document.getElementById('disclaimer').textContent='⚠ '+DATA.disclaimer;
renderFilters();renderGrid();
</script>
</body>
</html>
"""

if __name__ == "__main__":
    main()
