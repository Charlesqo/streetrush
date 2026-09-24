import pathlib,json,struct,hashlib,sys
root=pathlib.Path(__file__).resolve().parents[1];source=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/streetrush-venue-optimized.glb');b=source.read_bytes();n=struct.unpack_from('<I',b,12)[0];doc=json.loads(b[20:20+n]);binary=b[28+n:];target=root/'public/scenery/longwan';files=set();imageviews=set()
reportpath=root/'scratch/pit-game-preview-20260907/production-assets.json';old=json.loads(reportpath.read_text()).get('files',[]) if reportpath.exists() else []
for im in doc['images']:
 i=im.pop('bufferView');imageviews.add(i);v=doc['bufferViews'][i];data=binary[v.get('byteOffset',0):v.get('byteOffset',0)+v['byteLength']];name='map-'+hashlib.sha256(data).hexdigest()[:16]+('.png' if im['mimeType']=='image/png' else '.jpg');(target/name).write_bytes(data);im['uri']=name;files.add(name)
chunks=[bytearray()];views=[];mapping={}
for i,v in enumerate(doc['bufferViews']):
 if i in imageviews:continue
 data=binary[v.get('byteOffset',0):v.get('byteOffset',0)+v['byteLength']]
 if len(chunks[-1])+len(data)>16*1024*1024:chunks.append(bytearray())
 chunk=chunks[-1];chunk.extend(b'\0'*(-len(chunk)%4));new=dict(v);new.update(buffer=len(chunks)-1,byteOffset=len(chunk));chunk.extend(data);mapping[i]=len(views);views.append(new)
for a in doc['accessors']:a['bufferView']=mapping[a['bufferView']]
doc['bufferViews']=views;doc['buffers']=[]
for i,chunk in enumerate(chunks):
 name=f'venue-{i}.bin';(target/name).write_bytes(chunk);files.add(name);doc['buffers'].append({'uri':name,'byteLength':len(chunk)})
(target/'venue.gltf').write_text(json.dumps(doc,separators=(',',':')));files.add('venue.gltf')
for name in old:
 if name not in files:
  p=target/name
  assert p.parent==target and (name.startswith('map-') or name.startswith('venue-'))
  p.unlink(missing_ok=True)
r={'files':sorted(files),'total_bytes':sum((target/f).stat().st_size for f in files),'max_file_bytes':max((target/f).stat().st_size for f in files),'unique_triangles':sum(doc['accessors'][p['indices']]['count']//3 for m in doc['meshes'] for p in m['primitives']),'source':str(source),'preserved_original':True};reportpath.write_text(json.dumps(r,indent=2));print(json.dumps({k:v for k,v in r.items() if k!='files'}))
