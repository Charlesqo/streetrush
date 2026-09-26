"""Finite structural verification of delivered model containers and preview images.
Does not certify visual quality, collision, or game performance.
"""
import json,struct,hashlib
from pathlib import Path
from PIL import Image
ROOT=Path(__file__).resolve().parents[1]
report={'scope':'Independent asset files only; visual judgement recorded separately.','checks':[]}
def check(name,ok,detail):
    report['checks'].append({'check':name,'result':'PASS' if ok else 'FAIL','detail':detail})
for path in [ROOT/'scene'/'longwan_pit_exit.glb',*sorted((ROOT/'models').rglob('*.glb'))]:
    if not path.exists():check(str(path.relative_to(ROOT)),False,'missing');continue
    data=path.read_bytes();magic,version,length=struct.unpack_from('<III',data)
    jl,jtype=struct.unpack_from('<II',data,12);g=json.loads(data[20:20+jl])
    external=[x.get('uri') for x in g.get('images',[]) if x.get('uri')]
    embedded=all('bufferView' in im for im in g.get('images',[]))
    check(str(path.relative_to(ROOT)),magic==0x46546c67 and version==2 and length==len(data) and embedded and not external,{'bytes':len(data),'nodes':len(g.get('nodes',[])),'meshes':len(g.get('meshes',[])),'materials':len(g.get('materials',[])),'embedded_images':len(g.get('images',[])),'external_images':external})
expected=['01_overall','02_driving','03_reverse','04_garage','05_facilities','06_surface','07_control','08_rear']
for path in [ROOT/'previews'/f'{name}.png' for name in expected]:
    if not path.exists():check(str(path.relative_to(ROOT)),False,'required final view missing');continue
    with Image.open(path) as im:
        im.load();check(str(path.relative_to(ROOT)),im.width>=1200 and im.height>=700,{'width':im.width,'height':im.height})
blend=ROOT/'scene'/'longwan_pit_exit_editable.blend'
check('Editable Blender scene',blend.exists() and blend.stat().st_size>100_000,{'bytes':blend.stat().st_size if blend.exists() else 0,'reopen_required':'Blender reopen and export logs are separate evidence'})
sm=json.loads((ROOT/'sources'/'source-manifest.json').read_text())
for item in sm['preserved_files']:
    p=ROOT/item['file'];check('original '+item['file'],p.exists() and hashlib.sha256(p.read_bytes()).hexdigest()==item['sha256'],'Preserved source SHA256')
report['result']='PASS' if all(c['result']=='PASS' for c in report['checks']) else 'FAIL'
report['not_run']=['Game integration','Collision model','Target-device game performance','Production rendering equivalence']
(ROOT/'review'/'bundle-verification.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf8')
print(json.dumps({'result':report['result'],'checks':len(report['checks'])}))
raise SystemExit(0 if report['result']=='PASS' else 1)
