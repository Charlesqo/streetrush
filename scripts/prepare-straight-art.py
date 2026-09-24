"""Prepare the local straight review from the user's downloads, without modifying sources."""
import hashlib
import json
import pathlib
import shutil
import struct
import zipfile
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / 'Megascans_已拥有' / '已下载'
DEST = ROOT / 'scratch' / 'straight-art-20260916' / 'assets'
DEST.mkdir(parents=True, exist_ok=True)
records = []

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

for key, package, identifier in [
    ('asphalt', 'fine_asphalt_vlzobiady_4k.zip', 'vlzobiady'),
    ('fresh', 'asphalt_fresh_sfrofg0a_4k.zip', 'sfrofg0a'),
    ('grass', 'grass_lawn_sfklehwa_4k.zip', 'sfklehwa'),
    ('gravel', 'gravel_ground_tl3hegckw_4k.zip', 'tl3hegckw'),
    ('dust', 'tileable_road_dust_shcl0jn_4k.zip', 'shcl0jn'),
    ('patch', 'asphalt_patch_smooth_sbqpo0p_4k.zip', 'sbqpo0p'),
]:
    output = DEST / key
    output.mkdir(exist_ok=True)
    maps = {}
    with zipfile.ZipFile(SOURCE / package) as archive:
        for channel in ['BaseColor', 'Normal', 'Roughness', 'AO', 'Opacity']:
            matches = [n for n in archive.namelist() if n.lower().endswith('_' + channel.lower() + '.jpg')]
            if not matches:
                continue
            target = output / (channel + '.jpg')
            with archive.open(matches[0]) as src, target.open('wb') as dst:
                shutil.copyfileobj(src, dst)
            maps[channel] = str(target.relative_to(DEST)).replace('\\', '/')
    # Lossless channel packing preserves all source pixels at 4K.
    with Image.open(output / 'AO.jpg') as ao, Image.open(output / 'Roughness.jpg') as roughness:
        Image.merge('RGB', (ao.convert('L'), roughness.convert('L'), Image.new('L', ao.size, 0))).save(output / 'ORM.png')
    maps['ORM'] = f'{key}/ORM.png'
    records.append({'key': key, 'source': package, 'asset_id': identifier,
                    'sha256': digest(SOURCE / package), 'maps': maps})

for key, package in [
    ('guardrail', 'modular_metal_guardrail_kit_uh5gcflfa_high.glb'),
    ('guardrail-mid', 'modular_metal_guardrail_kit_uh5gcflfa_mid.glb'),
    ('guardrail-low', 'modular_metal_guardrail_kit_uh5gcflfa_low.glb'),
    ('barrier', 'concrete_barrier_tmrvaayda_high.glb'),
]:
    output = DEST / key
    output.mkdir(exist_ok=True)
    with (SOURCE / package).open('rb') as file:
        file.seek(12)
        size, kind = struct.unpack('<II', file.read(8))
        doc = json.loads(file.read(size))
        size, kind = struct.unpack('<II', file.read(8))
        binary = file.read(size)
    image_views = {image['bufferView'] for image in doc['images']}
    for i, image in enumerate(doc['images']):
        view = doc['bufferViews'][image['bufferView']]
        ext = '.png' if image['mimeType'] == 'image/png' else '.jpg'
        name = f'image-{i}{ext}'
        offset = view.get('byteOffset', 0)
        if key not in ('guardrail-mid', 'guardrail-low'):
            (output / name).write_bytes(binary[offset:offset + view['byteLength']])
        image.pop('bufferView')
        image['uri'] = name
    # Repackage original vertex/index bytes without simplification or texture changes.
    geometry = bytearray()
    views, remap = [], {}
    for i, view in enumerate(doc['bufferViews']):
        if i in image_views:
            continue
        geometry.extend(b'\0' * ((-len(geometry)) % 4))
        offset = view.get('byteOffset', 0)
        copied = dict(view, buffer=0, byteOffset=len(geometry))
        remap[i] = len(views)
        views.append(copied)
        geometry.extend(binary[offset:offset + view['byteLength']])
    for accessor in doc['accessors']:
        if 'bufferView' in accessor:
            accessor['bufferView'] = remap[accessor['bufferView']]
    doc['bufferViews'] = views
    doc['buffers'] = [{'byteLength': len(geometry), 'uri': 'geometry.bin'}]
    if key in ('guardrail-mid', 'guardrail-low'):
        doc['images'] = []; doc['textures'] = []; doc['samplers'] = []
        doc['materials'] = [{'name': 'Geometry only; runtime reuses High 4K material'}]
        for mesh in doc['meshes']:
            for primitive in mesh['primitives']:
                primitive['material'] = 0
    (output / 'geometry.bin').write_bytes(geometry)
    (output / 'model.gltf').write_text(json.dumps(doc), encoding='utf-8')
    records.append({'key': key, 'source': package, 'tier': package.rsplit('_', 1)[-1].split('.')[0],
                    'sha256': digest(SOURCE / package), 'file': f'{key}/model.gltf'})

for identifier in ['rbojr', 'rbptq']:
    package = 'grass_clumps_' + identifier + '_ue_high.zip'
    output = (DEST / identifier).resolve()
    output.mkdir(exist_ok=True)
    with zipfile.ZipFile(SOURCE / package) as archive:
        for member in archive.infolist():
            if not member.filename.endswith(('.gltf', '.bin', '.png')):
                continue
            target = (output / member.filename).resolve()
            if not target.is_relative_to(output):
                raise ValueError('Archive entry escapes destination')
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as src, target.open('wb') as dst:
                shutil.copyfileobj(src, dst)
    standard = output / 'standard' / f'{identifier}_tier_1_nonUE.gltf'
    doc = json.loads(standard.read_text(encoding='utf-8'))
    # Billboard LOD is not used by this preview. Avoid decoding its unused atlases.
    for scene in doc['scenes']:
        scene['nodes'] = [i for i in scene['nodes'] if '_LOD2' not in doc['nodes'][i].get('name', '')]
    standard.write_text(json.dumps(doc), encoding='utf-8')
    records.append({'key': identifier, 'source': package, 'tier': 'high',
                    'sha256': digest(SOURCE / package),
                    'file': f'{identifier}/standard/{identifier}_tier_1_nonUE.gltf'})

(DEST / 'manifest.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'prepared_assets': len(records), 'destination': str(DEST),
                  'source_files_unchanged': True}, ensure_ascii=False))
