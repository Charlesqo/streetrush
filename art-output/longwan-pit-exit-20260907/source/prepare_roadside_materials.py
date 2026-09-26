"""Author coating/deposit derivatives from acquired PBR; keep every source intact."""
import json, hashlib
from pathlib import Path
import numpy as np
from PIL import Image
def gaussian_filter(a,sigma):
    """Periodic blur with bundled NumPy only; source runtime has no SciPy."""
    sy,sx=sigma if isinstance(sigma,tuple) else (sigma,sigma)
    h,w=a.shape
    weight=np.exp(-2*np.pi**2*((np.fft.fftfreq(h)[:,None]*sy)**2+(np.fft.rfftfreq(w)[None,:]*sx)**2))
    return np.fft.irfft2(np.fft.rfft2(a)*weight,s=a.shape).real

R=Path(__file__).resolve().parents[1];OUT=R/'materials/roadside';OUT.mkdir(parents=True,exist_ok=True)
rng=np.random.default_rng(79112);report=[]
def save(name,a,source,note):
    p=OUT/name;a=np.uint8(np.clip(a,0,1)*255+.5)
    im=Image.fromarray(a);im.save(p,quality=96,subsampling=0) if p.suffix=='.jpg' else im.save(p)
    report.append({'file':str(p.relative_to(R)),'source':source,'treatment':note,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
def read(path,size=None):
    im=Image.open(path).convert('RGB')
    if size:im=im.resize(size,Image.Resampling.LANCZOS)
    return np.asarray(im,dtype=np.float32)/255
con=R/'sources/pbr/polyhaven/rough_concrete'
diff=np.tile(read(con/'rough_concrete_diff_2k.jpg',(1024,1024)),(1,2,1))
arm=np.tile(read(con/'rough_concrete_arm_2k.jpg',(1024,1024)),(1,2,1))
normal=np.tile(read(con/'rough_concrete_nor_gl_2k.jpg',(1024,1024)),(1,2,1))
h,w=diff.shape[:2];yy,xx=np.mgrid[:h,:w];x=xx/w*4;y=yy/h*2
lum=diff.mean(2);detail=np.clip(lum/max(lum.mean(),.001),.65,1.4)
field=gaussian_filter(rng.random((h,w)),12);field=(field-field.min())/(field.max()-field.min())
fine=gaussian_filter(rng.random((h,w)),1.2)
edge=(np.minimum(x%1,1-x%1)<(.007+field*.034)) | (y<(.006+field*.035))
pores=(lum<np.quantile(lum,.06)) & (fine>.50)
chip=(edge & (field>.47)) | (pores & (field>.53))
colour=np.where((np.floor(x).astype(int)%2==0)[...,None],np.array([.79,.785,.74]),np.array([.68,.18,.105]))
paint=colour*(.88+.12*detail[...,None]);paint=np.where(chip[...,None],diff*.95,paint)
# Thin accumulated rubber/dust remains localized on the contact side of the kerb.
rubber=(np.exp(-((y-(.19+.018*np.sin(x*4))) / .041)**2))*(.17+.19*field)*(fine>.47)
paint*=1-rubber[...,None]
rough=np.where(chip,arm[:,:,1],np.clip(.68+arm[:,:,1]*.13+rubber*.18,.65,.96))
coat_arm=np.dstack([arm[:,:,0],rough,np.zeros_like(rough)])
save('kerb_coating_base.jpg',paint,'Poly Haven rough_concrete','4m × 2m metric atlas: 1m alternating paint bands, exposed cement chips, localized contact deposits')
save('kerb_coating_normal.png',normal,'Poly Haven rough_concrete','OpenGL normal retained; spatial repeat copied without invented large bumps')
save('kerb_coating_arm.png',coat_arm,'Poly Haven rough_concrete','AO retained; coating roughness differs from exposed concrete; nonmetallic')

# Fix the source glTF JPEG that could not carry its opacity.
f=R/'sources/free-models/modular_chainlink_fence/textures'
base=Image.open(f/'modular_chainlink_fence_wire_diff_2k.jpg').convert('RGB')
alpha=Image.open(f/'modular_chainlink_fence_wire_opacity_2k.png').convert('L')
assert base.size==alpha.size;base.putalpha(alpha)
p=OUT/'chainlink_wire_base_alpha.png';base.save(p)
report.append({'file':str(p.relative_to(R)),'source':'Poly Haven modular_chainlink_fence: original diffuse + original opacity','treatment':'Combined matching opacity; no generated wire shape','sha256':hashlib.sha256(p.read_bytes()).hexdigest()})

# A narrow dust fringe uses gravel colour and actual photographic grain.
gd=read(R/'sources/pbr/polyhaven/gravel_stones/gravel_stones_diff_2k.jpg',(1024,256))
h,w=gd.shape[:2];yy,xx=np.mgrid[:h,:w];v=yy/(h-1)
noise=gaussian_filter(rng.random((h,w)),3);noise=(noise-noise.min())/(noise.max()-noise.min())
a=np.clip((1-v)*(.65+noise*.6)-noise*.25,0,1)**1.6
a*=.5+.5*rng.random((h,w))
save('gravel_dust_fringe.png',np.dstack([gd,a*.6]),'Poly Haven gravel_stones','4m × 0.30m deposition decal; strongest at gravel edge')

# Rubber traces: a faint long contact band with photographic aggregate breakup.
ad=read(R/'sources/pbr/refinement/asphalt_track/asphalt_track_diff_2k.jpg',(1024,128))
h,w=ad.shape[:2];yy,xx=np.mgrid[:h,:w];u=xx/(w-1);v=yy/(h-1)
long=gaussian_filter(rng.random((h,w)),(1,18));long=(long-long.min())/(long.max()-long.min())
a=(np.sin(np.pi*v)**1.1)*np.minimum(1,u*12)*np.minimum(1,(1-u)*12)*(.1+.3*long)
save('rubber_contact_band.png',np.dstack([ad*.5,a]),'Poly Haven asphalt_track','12m × 0.24m contact mark; preserves underlying road through alpha')
# Track-limit paint retains the road's aggregate and small exposed pinholes.
ad=read(R/'sources/pbr/refinement/asphalt_track/asphalt_track_diff_2k.jpg',(1024,1024))
aa=read(R/'sources/pbr/refinement/asphalt_track/asphalt_track_arm_2k.jpg',(1024,1024))
grain=ad.mean(2);factor=np.clip(grain/grain.mean(),.55,1.5)
white=np.array([.785,.79,.76])[None,None,:]*(.87+.13*factor[:,:,None])
exposed=(grain<np.quantile(grain,.065)) & (rng.random(grain.shape)>.42)
white=np.where(exposed[:,:,None],ad,white)
save('track_limit_base.jpg',white,'Poly Haven asphalt_track','2m repeat; paint albedo with exposed aggregate pinholes')
save('track_limit_arm.png',np.dstack([aa[:,:,0],np.maximum(aa[:,:,1],.75),np.zeros_like(grain)]),'Poly Haven asphalt_track','AO and roughness retained for worn nonmetallic paint')
(OUT/'derivatives.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print('ROADSIDE_DERIVATIVES_COMPLETE',len(report))
