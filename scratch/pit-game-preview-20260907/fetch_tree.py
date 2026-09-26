import json,pathlib,subprocess,concurrent.futures,hashlib
base=pathlib.Path('/Volumes/Storage/streetrush/scratch/pit-game-preview-20260907/tree-source');j=json.load(open('/tmp/streetrush-jacaranda-files.json'))['gltf']['1k']['gltf'];items=[('jacaranda_tree_1k.gltf',j),*j['include'].items()]
def get(item):
 name,info=item;p=base/name;p.parent.mkdir(parents=True,exist_ok=True)
 subprocess.run(['curl','-sS','-L','--fail','--retry','2','--max-time','180',info['url'],'-o',str(p)],check=True)
 assert hashlib.md5(p.read_bytes()).hexdigest()==info['md5'];return name
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 for name in pool.map(get,items):print('VERIFIED',name,flush=True)
(base/'provenance.json').write_text(json.dumps({'source':'https://polyhaven.com/a/jacaranda_tree','license':'CC0-1.0','author':'Rico Cilliers; Rob Tuytel','files':dict(items)},indent=2))
