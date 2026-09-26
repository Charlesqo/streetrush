import json,struct,pathlib,subprocess,tempfile,hashlib
root=pathlib.Path('/Volumes/Storage/streetrush')
src=root/'art-output/longwan-pit-exit-20260907/models/longwan_region_realtime.glb'
b=src.read_bytes(); n=struct.unpack_from('<I',b,12)[0]; d=json.loads(b[20:20+n]); binary=b[28+n:]
# Keep the original geometry of a small group of pit facilities.
keep=[0,1,2,3,4,5,6,8,9,10,11,12,14,15,16,17,18,19,20,21,22,23]
# Omit the sample main road and broad terrain; use the real game track.
for ni in [17]:
 d['meshes'][d['nodes'][ni]['mesh']]['primitives']=[p for p in d['meshes'][d['nodes'][ni]['mesh']]['primitives'] if d['materials'][p['material']]['name'] not in ['Varied grass','Region paving','Varied asphalt','Track limit paint']]
for ni in [18,19,20,21]:
 d['meshes'][d['nodes'][ni]['mesh']]['primitives']=[p for p in d['meshes'][d['nodes'][ni]['mesh']]['primitives'] if d['materials'][p['material']]['name'] not in ['Varied asphalt','Rubber contact trace','Track limit paint','Worn kerb coating','Joint seal']]
# Remove only the raised kerb body from the shared roadside concrete primitive.
# The concrete under the drains and fence stays. Source GLB is never modified.
for primitive in d['meshes'][d['nodes'][18]['mesh']]['primitives']:
 if d['materials'][primitive['material']]['name']!='Concrete.001':continue
 pa=d['accessors'][primitive['attributes']['POSITION']];pv=d['bufferViews'][pa['bufferView']]
 ia=d['accessors'][primitive['indices']];iv=d['bufferViews'][ia['bufferView']]
 posbase=pv.get('byteOffset',0)+pa.get('byteOffset',0);stride=pv.get('byteStride',12)
 fmt,size={5121:('B',1),5123:('H',2),5125:('I',4)}[ia['componentType']]
 ibase=iv.get('byteOffset',0)+ia.get('byteOffset',0)
 indices=struct.unpack_from('<'+fmt*ia['count'],binary,ibase);kept=[]
 for offset in range(0,len(indices),3):
  tri=indices[offset:offset+3]
  if not all(struct.unpack_from('<fff',binary,posbase+i*stride)[2]>=-1.08 for i in tri):kept.extend(tri)
 binary+=b'\0'*(-len(binary)%4);start=len(binary);encoded=struct.pack('<'+'I'*len(kept),*kept);binary+=encoded
 d['bufferViews'].append({'buffer':0,'byteOffset':start,'byteLength':len(encoded),'target':34963})
 d['accessors'].append({'bufferView':len(d['bufferViews'])-1,'componentType':5125,'count':len(kept),'type':'SCALAR'})
 primitive['indices']=len(d['accessors'])-1
# Reuse one 24 m roadside module at four placements in the trial.
for ni in [19,20,21]:d['nodes'][ni]['mesh']=d['nodes'][18]['mesh']
meshids=sorted({d['nodes'][i]['mesh'] for i in keep}); meshes=[d['meshes'][i] for i in meshids]
accids=sorted({a for m in meshes for p in m['primitives'] for a in [*p['attributes'].values(),p['indices']]})
mats=sorted({p['material'] for m in meshes for p in m['primitives']})
def texrefs(x):
 if isinstance(x,dict):
  for k,v in x.items():
   if k.endswith('Texture') and isinstance(v,dict) and 'index' in v: yield v
   else: yield from texrefs(v)
 elif isinstance(x,list):
  for v in x: yield from texrefs(v)
texids=sorted({t['index'] for i in mats for t in texrefs(d['materials'][i])})
imgids=sorted({d['textures'][i]['source'] for i in texids})
viewids=sorted({d['accessors'][i]['bufferView'] for i in accids}|{d['images'][i]['bufferView'] for i in imgids})
remap=lambda ids:{v:i for i,v in enumerate(ids)}
mi,ai,ma,ti,ii,vi=map(remap,[meshids,accids,mats,texids,imgids,viewids])
nodes=[d['nodes'][i] for i in keep]
for node in nodes: node['mesh']=mi[node['mesh']]
for m in meshes:
 for p in m['primitives']:
  p['indices']=ai[p['indices']];p['attributes']={k:ai[v] for k,v in p['attributes'].items()};p['material']=ma[p['material']]
materials=[d['materials'][i] for i in mats]
for mat in materials:
 for t in texrefs(mat):t['index']=ti[t['index']]
textures=[d['textures'][i] for i in texids]
for t in textures:t['source']=ii[t['source']]
images=[d['images'][i] for i in imgids]; replacements={}
with tempfile.TemporaryDirectory() as tmp:
 for i,im in enumerate(images):
  v=d['bufferViews'][im['bufferView']];data=binary[v.get('byteOffset',0):v.get('byteOffset',0)+v['byteLength']]
  p=pathlib.Path(tmp)/('image'+str(i)+('.png' if im['mimeType']=='image/png' else '.jpg'));p.write_bytes(data)
  subprocess.run(['sips','-Z','1024',str(p)],stdout=subprocess.DEVNULL,check=True)
  replacements[im['bufferView']]=p.read_bytes();im['bufferView']=vi[im['bufferView']]
newbin=bytearray();views=[];stored={}
for i in viewids:
 v=dict(d['bufferViews'][i]);data=replacements.get(i,binary[v.get('byteOffset',0):v.get('byteOffset',0)+v['byteLength']]);newbin.extend(b'\0'*(-len(newbin)%4));digest=hashlib.sha256(data).digest();offset=stored.get(digest)
 if offset is None:offset=len(newbin);stored[digest]=offset;newbin.extend(data)
 v.update(byteOffset=offset,byteLength=len(data));views.append(v)
accessors=[d['accessors'][i] for i in accids]
for a in accessors:a['bufferView']=vi[a['bufferView']]
new=dict(asset=d['asset'],scene=0,scenes=[{'nodes':list(range(len(nodes)))}],nodes=nodes,meshes=meshes,accessors=accessors,materials=materials,textures=textures,images=images,samplers=d.get('samplers',[]),bufferViews=views,buffers=[{'byteLength':len(newbin)}])
for k in ['extensionsUsed','extensionsRequired']:
 if k in d:new[k]=d[k]
j=json.dumps(new,separators=(',',':')).encode();j+=b' '*(-len(j)%4);newbin.extend(b'\0'*(-len(newbin)%4))
out=root/'scratch/pit-game-preview-20260907/pit-facilities.glb';out.write_bytes(struct.pack('<III',0x46546c67,2,28+len(j)+len(newbin))+struct.pack('<II',len(j),0x4e4f534a)+j+struct.pack('<II',len(newbin),0x004e4942)+newbin)
print(json.dumps({'output':str(out),'bytes':out.stat().st_size,'nodes':len(nodes),'materials':len(materials),'triangles':sum(accessors[p['indices']]['count']//3 for m in meshes for p in m['primitives'])}))
