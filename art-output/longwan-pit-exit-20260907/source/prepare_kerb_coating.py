"""Metric PBR channel compositing from two preserved CC0 painted-floor scans.
Re-colour the coating, retain photographed wear, and add localized tire-contact masks.
This creates material channels, not a rendered texture with baked illumination.
"""
import json,hashlib
from pathlib import Path
import numpy as np
from PIL import Image
R=Path(__file__).resolve().parents[1];O=R/'materials/kerb-r03';O.mkdir(parents=True,exist_ok=True)
A=R/'sources/pbr/kerb-refinement/painted_concrete_02'
B=R/'sources/pbr/kerb-refinement/concrete_floor_painted'
def read(folder,stem,channel):
    return np.asarray(Image.open(folder/f'{stem}_{channel}_2k.jpg').convert('RGB'),np.float32)/255
def patch(channel):
    # 4m × 4m source: retain a 4m × 2m crop at 512 pixels / metre.
    return read(A,'painted_concrete_02',channel)[:1024]
def wear(channel):
    # 2m source repeats twice over the 4m atlas. Preserve channel registration.
    im=Image.open(B/f'concrete_floor_painted_{channel}_2k.jpg').convert('RGB').resize((1024,1024),Image.Resampling.LANCZOS)
    return np.tile(np.asarray(im,np.float32)/255,(1,2,1))
def ramp(a,lo,hi):
    t=np.clip((a-lo)/(hi-lo),0,1);return t*t*(3-2*t)
ad=patch('diff');aa=patch('arm');an=patch('nor_gl');bd=wear('diff');ba=wear('arm');bn=wear('nor_gl')
h,w=ad.shape[:2];yy,xx=np.mgrid[:h,:w];x=xx/w*4;y=yy/h*2
al=ad.mean(2);bl=bd.mean(2)
# Warm, lighter exposed concrete in the scanned floor drives irregular flaking.
exposure=ramp(bd[:,:,0]-bd[:,:,2],.026,.073)*ramp(bl,.23,.43)
local=.08+.92*ramp(.5+.5*np.sin(x*1.72+y*3.1),.32,.79)
exposure=np.clip(exposure**1.4*local,0,1)
# Paint is retained over most of the surface. Crest abrasion follows the actual 0.5m ribs.
crest=np.exp(-((x%.5-.4)/.014)**2)
grain=np.clip(al/al.mean(),.65,1.4)
exposure=np.maximum(exposure,crest*.24*ramp(bl,.22,.42))
red=np.array([.65,.205,.145]);ivory=np.array([.79,.79,.748])
colour=np.where((np.floor(x).astype(int)%2==0)[...,None],ivory,red)
paint=colour*(.72+.28*grain[...,None])
cement=np.array([.50,.477,.436])[None,None,:]*np.clip(bl/.36,.69,1.23)[...,None]
base=paint*(1-exposure[...,None])+cement*exposure[...,None]
# Short broken contact passes with a slight lateral drift, not a stripe on every block.
pass1=np.exp(-((y-(.63+x*.055))/.12)**4)*np.exp(-((x-1.18)/.72)**4)
pass2=np.exp(-((y-(1.53-x*.043))/.08)**4)*np.exp(-((x-3.13)/.47)**4)
streak=.30+.70*ramp(np.sin(y*395+x*1.9)+grain*.7,-.4,1.2)
rubber=np.clip((pass1*.44+pass2*.32)*streak*(.4+.6*ramp(bl,.19,.43)),0,.55)
base*=1-rubber[...,None]
rough=np.clip((.50+.26*aa[:,:,1])*(1-exposure)+(.79+.13*ba[:,:,1])*exposure+rubber*.14,.48,.96)
ao=aa[:,:,0]*(1-exposure)+ba[:,:,0]*exposure
normal=an*(1-exposure[...,None])+bn*exposure[...,None]
v=normal*2-1;v[:,:,:2]*=.70;v/=np.maximum(np.linalg.norm(v,axis=2,keepdims=True),.0001);normal=v*.5+.5
report={'atlas_metres':[4,2],'pixels':[w,h],'sources':[str(A.relative_to(R)),str(B.relative_to(R))],'authors':['Rob Tuytel / Poly Haven'],'license':'CC0','treatment':'Registered scan channels; recoloured intact coating, scan-driven exposed cement, localized authored tire contact, modest crest abrasion. No baked lighting.','files':[]}
for name,arr in [('kerb_coating_base.jpg',base),('kerb_coating_normal.png',normal),('kerb_coating_arm.png',np.dstack([ao,rough,np.zeros_like(ao)]))]:
    path=O/name;im=Image.fromarray(np.uint8(np.clip(arr,0,1)*255+.5))
    if path.suffix=='.jpg':im.save(path,quality=96,subsampling=0)
    else:im.save(path)
    report['files'].append({'file':str(path.relative_to(R)),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size})
(O/'derivatives.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print('KERB_COATING_COMPLETE',json.dumps(report))
