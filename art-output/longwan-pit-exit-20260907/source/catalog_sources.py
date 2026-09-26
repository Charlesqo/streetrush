"""Preserve sourced PBR files, record original provenance and content hashes."""
import hashlib,json,shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ORIGINAL=ROOT.parent/'costa-service-20260907'/'sources'
TARGET=ROOT/'sources'/'pbr'
if not TARGET.exists() and ORIGINAL.exists():shutil.copytree(ORIGINAL,TARGET)
rows=[]
source_roots=[TARGET,ROOT/'sources'/'free-models',ROOT/'sources'/'native-models']
preserved=[path for folder in source_roots for path in folder.rglob('*')]
for path in sorted(preserved):
    if not path.is_file():continue
    rows.append({'file':str(path.relative_to(ROOT)),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
assets=[]
for path in [path for folder in source_roots for path in folder.rglob('*-info.json')]:
    data=json.loads(path.read_text());ident=path.name.removeprefix('polyhaven-').removesuffix('-info.json')
    assets.append({'id':ident,'title':data.get('name'),'authors':data.get('authors'),'source':f'https://polyhaven.com/a/{ident}','license':'CC0-1.0','license_url':'https://polyhaven.com/license','source_metadata':str(path.relative_to(ROOT)),'source_dimensions_raw_api':data.get('dimensions'),'raw_dimension_note':'Original API values retained without assuming units; authored physical texture repeat is recorded on Blender materials.','acquired_quality_status':'Files acquired; rendered review required','channels':'diff=sRGB base colour; nor_gl=linear OpenGL normal; arm=linear R ambient occlusion, G roughness, B metallic'})
assets.append({'id':'kloofendal_48d_partly_cloudy_puresky','title':'Kloofendal 48d Partly Cloudy (Pure Sky)','authors':{'Greg Zaal':'original','Jarod Guest':'sky edit'},'source':'https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky','license':'CC0-1.0','license_url':'https://polyhaven.com/license','evidence':'Copied byte-for-byte from project original; source recorded in repository licenses/assets.json.'})
for path in (TARGET/'ambientcg').glob('*/provenance.json'):
    data=json.loads(path.read_text())
    assets.append({'id':data['asset_id'],'title':data['title'],'authors':{'ambientCG':'provider'},'source':data['source']['asset_page_url'],'license':data['license']['name'],'license_url':data['license']['source_license_url'],'technique':data['license']['technique'],'source_metadata':str(path.relative_to(ROOT)),'acquired_quality_status':data['quality_status'],'channels':'Original provider-labelled Color, Roughness, Metalness, NormalGL, NormalDX, Displacement retained; authored scale is recorded on derived material.'})
(ROOT/'sources'/'source-manifest.json').write_text(json.dumps({'date':'2026-09-07','sources':assets,'preserved_files':rows},indent=2,ensure_ascii=False),encoding='utf8')
print(f'Catalogued {len(rows)} preserved files and {len(assets)} external assets')
