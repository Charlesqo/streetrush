"""Make a separate realtime derivative; preserve source GLB and every original map.

Only embedded image encoding changes. UVs, meshes, material factors and map
connections are unchanged. RGB normals remain lossless 8-bit PNG, as consumed
by the WebGL texture upload. Colour maps without alpha use JPEG quality 95.
"""
import argparse, copy, hashlib, io, json, struct
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--source',default='models/longwan_pit_building_native.glb')
parser.add_argument('--output',default='models/longwan_pit_building_realtime.glb')
parser.add_argument('--report',default='review/native-runtime-pack.json')
args=parser.parse_args()
source = ROOT / args.source
target = ROOT / args.output
raw = source.read_bytes()
magic, version, total = struct.unpack_from('<III', raw)
assert magic == 0x46546c67 and version == 2 and total == len(raw)
jsize, jtype = struct.unpack_from('<II', raw, 12)
assert jtype == 0x4e4f534a
doc = json.loads(raw[20:20+jsize])
original = copy.deepcopy(doc)
bsize, btype = struct.unpack_from('<II', raw, 20+jsize)
assert btype == 0x004e4942 and len(doc['buffers']) == 1
binary = raw[28+jsize:28+jsize+bsize]
replacements, rows = {}, []
alpha_images = set()
for material in doc['materials']:
    texture = material.get('pbrMetallicRoughness', {}).get('baseColorTexture')
    if texture and material.get('alphaMode', 'OPAQUE') != 'OPAQUE':
        alpha_images.add(doc['textures'][texture['index']]['source'])
for image_index, im in enumerate(doc['images']):
    idx = im['bufferView']; view = doc['bufferViews'][idx]
    data = binary[view.get('byteOffset', 0):view.get('byteOffset', 0)+view['byteLength']]
    pil = Image.open(io.BytesIO(data)); pil.load()
    is_colour = '_diff' in im['name'] and image_index not in alpha_images
    if image_index not in alpha_images and pil.mode == 'RGBA':
        pil = pil.convert('RGB')  # glTF does not consume alpha in these channels.
    out = io.BytesIO()
    if is_colour:
        pil.convert('RGB').save(out, format='JPEG', quality=95, subsampling=0, optimize=True)
        mime = 'image/jpeg'
    else:
        pil.save(out, format='PNG', optimize=True)
        mime = 'image/png'
    encoded = out.getvalue()
    # Already-compressed source JPEGs are retained unless the encoding is smaller.
    if len(encoded) >= len(data):
        encoded, mime = data, im['mimeType']
    replacements[idx] = encoded; im['mimeType'] = mime
    rows.append({'name': im['name'], 'dimensions': list(pil.size),
                 'source_bytes': len(data), 'runtime_bytes': len(encoded),
                 'runtime_mime': mime, 'source_sha256': hashlib.sha256(data).hexdigest(),
                 'runtime_sha256': hashlib.sha256(encoded).hexdigest()})
rebuilt = bytearray(); unchanged_geometry = True
for idx, view in enumerate(doc['bufferViews']):
    old = binary[view.get('byteOffset', 0):view.get('byteOffset', 0)+view['byteLength']]
    data = replacements.get(idx, old)
    rebuilt.extend(b'\0' * (-len(rebuilt) % 4))
    view['byteOffset'] = len(rebuilt); view['byteLength'] = len(data)
    rebuilt.extend(data)
    if idx not in replacements:
        unchanged_geometry = unchanged_geometry and hashlib.sha256(old).digest() == hashlib.sha256(data).digest()
doc['buffers'][0]['byteLength'] = len(rebuilt)
rebuilt.extend(b'\0' * (-len(rebuilt) % 4))
metadata = json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode()
metadata += b' ' * (-len(metadata) % 4)
result = struct.pack('<III', magic, version, 28+len(metadata)+len(rebuilt))
result += struct.pack('<II', len(metadata), jtype) + metadata
result += struct.pack('<II', len(rebuilt), btype) + rebuilt
assert unchanged_geometry and doc['materials'] == original['materials']
assert doc['accessors'] == original['accessors']
target.write_bytes(result)
report = {'source': str(source.relative_to(ROOT)), 'output': str(target.relative_to(ROOT)),
          'source_bytes': len(raw), 'runtime_bytes': len(result),
          'reduction_percent': round(100*(1-len(result)/len(raw)), 1),
          'geometry_uvs_material_connections_unchanged': unchanged_geometry,
          'maps': rows, 'visual_status': 'Pending actual browser inspection',
          'not_run': ['Target game performance', 'Game integration']}
(ROOT/args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps({k:v for k,v in report.items() if k != 'maps'}, ensure_ascii=False))
