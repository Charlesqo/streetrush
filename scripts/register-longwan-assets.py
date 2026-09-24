import json,pathlib,hashlib
root=pathlib.Path(__file__).resolve().parents[1];path=root/'licenses/assets.json';j=json.loads(path.read_text());prefix='public/scenery/longwan/';old={a['path']:a for a in j['assets']};manifest=json.loads((root/'art-output/longwan-pit-exit-20260907/sources/source-manifest.json').read_text())
tree_source=root/'scratch/pit-game-preview-20260907/tree-sprite.json'
if tree_source.exists():manifest['additionalSources']=[json.loads(tree_source.read_text())]
evidence=root/'licenses/evidence/longwan-venue-sources.json';evidence.write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
for p in (root/'public/scenery/longwan').rglob('*'):
 if not p.is_file():continue
 relative=str(p.relative_to(root));tree=p.name.startswith('tree-')
 old[relative]={'path':relative,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'kind':'track-scenery','title':'Longwan runtime scenery / '+p.name,'author':'Rico Cilliers; Rob Tuytel / Poly Haven' if tree else 'StreetRush assembly; Poly Haven and ambientCG contributors (see evidence)','source':'https://polyhaven.com/a/jacaranda_tree' if tree else 'https://polyhaven.com/a/modular_factory_facade','license':'CC0-1.0','attributionRequired':False,'publicDistribution':'allowed','commercialUse':'allowed','status':'cleared','shipped':True,'evidence':'licenses/evidence/longwan-venue-sources.json','derivation':'Reduced runtime model or scene texture; original art-output assets preserved'}
j['assets']=list(old.values());path.write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
