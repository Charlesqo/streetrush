"""Read-only investigation of the two actual 4K scans; no replacement assets.

Outputs are derived numerical measurements, not GPU captures or physical BRDF
measurements. Reads original ZIPs and prepared images, writes only beside script.
"""
from pathlib import Path
import gc
import hashlib
import io
import json
import math
import zipfile

import numpy as np
from PIL import Image, ExifTags

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
ASSETS = ROOT / 'scratch/straight-art-20260916/assets'
DOWNLOADS = ROOT.parent / 'Megascans_已拥有/已下载'
SEED = 20260916
RNG = np.random.default_rng(SEED)
N_SAMPLES = 180000
CASES = {
    'sun48_view10_front': (48., 10., 0.),
    'sun48_view10_side': (48., 10., 90.),
    'sun48_view10_back': (48., 10., 180.),
    'sun10_view10_front': (10., 10., 0.),
    'sun48_view30_front': (48., 30., 0.),
}


def srgb_to_linear(x):
    return np.where(x <= .04045, x / 12.92, ((x + .055) / 1.055) ** 2.4)


def stats(x):
    x = np.asarray(x)
    mean = float(np.mean(x, dtype=np.float64))
    std = float(np.std(x, dtype=np.float64))
    return {'mean': mean, 'std': std, 'cv': std / max(abs(mean), 1e-10),
            'quantiles_p01_p10_p50_p90_p99': np.quantile(x, [.01,.1,.5,.9,.99]).tolist()}


def corr(a, b):
    a, b = np.asarray(a).ravel().astype(np.float64), np.asarray(b).ravel().astype(np.float64)
    return float(np.corrcoef(a, b)[0, 1])


def block(x, by, bx=None):
    bx = by if bx is None else bx
    h, w = x.shape[:2]
    if x.ndim == 2:
        return x.reshape(h//by,by,w//bx,bx).mean(axis=(1,3),dtype=np.float32)
    return x.reshape(h//by,by,w//bx,bx,x.shape[2]).mean(axis=(1,3),dtype=np.float32)


def unit(n):
    return n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-10)


def vec(el, az):
    el, az = np.radians(el), np.radians(az)
    return np.array([np.cos(el)*np.cos(az),np.cos(el)*np.sin(az),np.sin(el)],np.float32)


def shade(p, case):
    """Three r180 Standard direct branch on a flat tangent frame, F0 .04.

    Unit directional radiance, exact r180 Schlick fit, correlated GGX visibility,
    no geometry roughness on flat plane. No IBL/AO/shadow/tone mapping. This is an
    operator reference for these maps, NOT ground-truth physical asphalt.
    p channels = linear RGB, decoded (unnormalized) XYZ normal, roughness, AO.
    """
    le, ve, az = case
    l, v = vec(le, az), vec(ve, 180.)
    h = unit(l+v)
    n = unit(p[...,3:6])
    nl = np.clip(np.sum(n*l,axis=-1),0.,1.)
    nv = np.clip(np.sum(n*v,axis=-1),0.,1.)
    nh = np.clip(np.sum(n*h,axis=-1),0.,1.)
    vh = np.clip(float(np.dot(v,h)),0.,1.)
    rough = np.clip(p[...,6],.0525,1.)
    a2 = rough ** 4
    visibility = .5 / np.maximum(nl*np.sqrt(a2+(1-a2)*nv*nv)+nv*np.sqrt(a2+(1-a2)*nl*nl),1e-6)
    distribution = a2 / (np.pi * (nh*nh*(a2-1)+1)**2)
    fresnel = .04 + .96 * 2**((-5.55473*vh-6.98316)*vh)
    spec = nl * fresnel * visibility * distribution
    lum = np.sum(p[...,:3]*[.2126,.7152,.0722],axis=-1)
    diff = lum * nl / np.pi
    return np.stack([diff,spec],axis=-1).astype(np.float32)


def sample(p, uv):
    """Repeat + bilinear, texel centers; no fractional LOD or AF approximation."""
    hh, ww = p.shape[:2]
    x = uv[:,0] * ww - .5
    # HTML texture flipY makes increasing v run upwards in original file.
    y = (1.-uv[:,1]) * hh - .5
    xi, yi = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = (x-xi).astype(np.float32)[:,None], (y-yi).astype(np.float32)[:,None]
    return ((p[yi%hh,xi%ww]*(1-fx)+p[yi%hh,(xi+1)%ww]*fx)*(1-fy)
            +(p[(yi+1)%hh,xi%ww]*(1-fx)+p[(yi+1)%hh,(xi+1)%ww]*fx)*fy)


def hash_uv(x):
    # Float64 CPU sin deliberately documented; not bit-identical GPU hash.
    dots = x @ np.array([[127.1,269.5],[311.7,183.3]])
    y = np.sin(dots)*43758.5453
    return y-np.floor(y)


def coordinates(uv):
    skew = np.stack([uv[:,0]-.57735027*uv[:,1],1.15470054*uv[:,1]],axis=-1)
    cell = np.floor(skew); f = skew-cell
    hi = f.sum(axis=1)>1
    a = cell.copy(); a[hi] += [1,1]
    b, c = cell+[1,0], cell+[0,1]
    w = np.stack([1-f[:,0]-f[:,1],f[:,0],f[:,1]],axis=1)
    w[hi] = np.stack([f[hi].sum(axis=1)-1,1-f[hi,1],1-f[hi,0]],axis=1)
    w = np.maximum(w,0)**3; w/=w.sum(axis=1,keepdims=True)
    return np.stack([uv+hash_uv(q)*7.17 for q in [a,b,c]],axis=1), w.astype(np.float32)


def sample_summary(p):
    n = unit(p[...,3:6]); nz=n[...,2]
    return {'linear_luma':stats(p[...,:3]@[.2126,.7152,.0722]),
            'roughness':stats(p[...,6]), 'normal_length_before_normalize':stats(np.linalg.norm(p[...,3:6],axis=-1)),
            'normal_tilt_degrees':stats(np.degrees(np.arccos(np.clip(nz,-1,1)))),
            'normalized_xy_squared_mean':float(np.mean(np.sum(n[...,:2]**2,axis=-1))),
            'correlation_luma_roughness':corr(p[...,:3]@[.2126,.7152,.0722],p[...,6])}


def map_metadata(key, zipname):
    result={}
    with zipfile.ZipFile(DOWNLOADS/zipname) as z:
        jn=next(n for n in z.namelist() if n.lower().endswith('.json'))
        meta=json.loads(z.read(jn))
        result['source_json_name']=jn
        result['meta']=meta['meta']
        result['semanticTags']=meta.get('semanticTags')
        result['map_metadata']=[m for m in meta['maps'] if m['mimeType']=='image/jpeg']
        result['normal_convention_fields']={k:v for k,v in meta.items() if any(t in k.lower() for t in ['normal','opengl','directx'])}
        result['map_hashes_and_exif']={}
        for ch in ['BaseColor','Normal','Roughness','AO']:
            entry=next(n for n in z.namelist() if n.lower().endswith('_'+ch.lower()+'.jpg'))
            source=z.read(entry)
            p=ASSETS/key/(ch+'.jpg')
            im=Image.open(p)
            exif={ExifTags.TAGS.get(k,str(k)):str(v)[:1000] for k,v in im.getexif().items()}
            result['map_hashes_and_exif'][ch]={'prepared_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),
                'zip_sha256':hashlib.sha256(source).hexdigest(),'matches':p.read_bytes()==source,'format':im.format,
                'size':list(im.size),'exif':exif,'icc_profile_present':'icc_profile' in im.info}
        aux={}
        for ch in ['Bump','Displacement','Gloss','Specular']:
            matches=[n for n in z.namelist() if n.lower().endswith('_'+ch.lower()+'.jpg')]
            if matches:
                aux[ch]=np.array(Image.open(io.BytesIO(z.read(matches[0]))).convert('L'),np.float32)/255
    return result,aux


def analyze(key,zipname,size_m):
    print('BEGIN',key,flush=True)
    result,aux=map_metadata(key,zipname)
    p=np.empty((4096,4096,8),np.float32)
    p[...,:3]=srgb_to_linear(np.array(Image.open(ASSETS/key/'BaseColor.jpg'),np.float32)/255)
    p[...,3:6]=np.array(Image.open(ASSETS/key/'Normal.jpg'),np.float32)/127.5-1
    p[...,6]=np.array(Image.open(ASSETS/key/'Roughness.jpg').convert('L'),np.float32)/255
    p[...,7]=np.array(Image.open(ASSETS/key/'AO.jpg').convert('L'),np.float32)/255
    result['scan_size_m']=size_m; result['texel_size_mm']=size_m*1000/4096
    ns=p[...,3:6]; lens=np.linalg.norm(ns,axis=-1)
    negative=ns[...,2]<0
    rows,cols=np.where(negative)
    result['full_resolution_normal']={
        'negative_z_count':int(negative.sum()),'negative_z_fraction':float(negative.mean()),
        'negative_z_bbox_xyxy':None if len(rows)==0 else [int(cols.min()),int(rows.min()),int(cols.max()),int(rows.max())],
        'negative_z_fraction_by_16x16_regions':block(negative.astype(np.float32),256).tolist(),
        'raw_length':stats(lens),'length_below_0_9_fraction':float((lens<.9).mean()),
        'length_above_1_1_fraction':float((lens>1.1).mean()),
        'tilt_above_60deg_fraction':float((ns[...,2]/np.maximum(lens,1e-9)<.5).mean())}
    del lens,negative,rows,cols
    # Joint pixel statistics preserve alignment. 1/16 deterministic grid plus
    # full-image statistics elsewhere avoids unnecessary multi-GB temporaries.
    joint=p[::4,::4].reshape(-1,8)
    names=['linear_luma','roughness','AO','normal_z','normal_xy_squared']
    n=unit(joint[:,3:6])
    values=np.stack([joint[:,:3]@[.2126,.7152,.0722],joint[:,6],joint[:,7],n[:,2],np.sum(n[:,:2]**2,axis=-1)],axis=-1)
    result['aligned_joint_stats']={'sample_count':len(joint),'sampling':'every fourth texel in x and y',
        'columns':names,'correlation':np.corrcoef(values,rowvar=False).tolist(),'by_luma_quintile':[]}
    bins=np.quantile(values[:,0],np.linspace(0,1,6))
    for i in range(5):
        sel=(values[:,0]>=bins[i])&(values[:,0]<=bins[i+1])
        result['aligned_joint_stats']['by_luma_quintile'].append({'range':bins[i:i+2].tolist(),
            'count':int(sel.sum()),'mean':values[sel].mean(axis=0).tolist()})
    result['full_source_sample_summary']=sample_summary(joint)
    result['roughness_tail_fractions']={str(v):float((p[...,6]<v).mean()) for v in [.3,.4,.5,.6,.7,.8]}
    result['gloss_one_minus_roughness_abs_error']=stats(np.abs(aux['Gloss']-(1-p[...,6])))
    # Bump correlation evidence only: infer sign consistency with height under
    # conventional height->normal derivation, not an official +Y/-Y declaration.
    bump=aux['Bump']
    result['height_normal_sign_checks']=[]
    for step in [1,2,4,8,16]:
        y=np.arange(step,4096-step,4); x=np.arange(step,4096-step,4)
        dx=(bump[np.ix_(y,x+step)]-bump[np.ix_(y,x-step)])/(2*step)
        dy=(bump[np.ix_(y+step,x)]-bump[np.ix_(y-step,x)])/(2*step)
        nx=p[np.ix_(y,x)][:,:,3]; ny=p[np.ix_(y,x)][:,:,4]
        result['height_normal_sign_checks'].append({'step_px':step,'corr_Nx_minus_dB_dx':corr(nx,-dx),
            'corr_Ny_plus_dB_dimageY':corr(ny,dy),'corr_Nx_minus_dB_dimageY':corr(nx,-dy)})
    del aux,bump,joint,n,values
    # Low-frequency box means distinguish native scan features from fine grain.
    low=[]
    for width in [1,16,64,128,256,512,1024]:
        q=p[::4,::4] if width==1 else block(p,width)
        y=q[...,:3]@[.2126,.7152,.0722]
        low.append({'box_side_px':width,'box_side_m':width*size_m/4096,'linear_luma':stats(y),
            'roughness':stats(q[...,6]),'AO':stats(q[...,7])})
    result['box_scale_statistics']=low
    print('source statistics done',key,flush=True)
    # Direct shading model at source texel centers; filter radiance as reference.
    footprints=[(4,4),(16,128),(32,512),(64,2048)]
    result['box_filter_operator_comparison']={}
    for cname,case in CASES.items():
        shaded=np.empty((4096,4096,2),np.float32)
        for row in range(0,4096,128):
            shaded[row:row+128]=shade(p[row:row+128],case)
        tests=[]
        for by,bx in footprints:
            filtered=block(p,by,bx)
            got=shade(filtered,case)
            ref=block(shaded,by,bx)
            tests.append({'footprint_xy_texels':[bx,by],
                'footprint_xy_mm':[bx*size_m*1000/4096,by*size_m*1000/4096],
                'blocks':int(ref.shape[0]*ref.shape[1]),
                'diffuse':{'reference':stats(ref[...,0]),'shade_after_average':stats(got[...,0]),
                           'relative_mean_bias':float(got[...,0].mean()/ref[...,0].mean()-1),
                           'normalized_rmse':float(np.sqrt(np.mean((got[...,0]-ref[...,0])**2))/ref[...,0].mean())},
                'specular':{'reference':stats(ref[...,1]),'shade_after_average':stats(got[...,1]),
                            'relative_mean_bias':float(got[...,1].mean()/ref[...,1].mean()-1),
                            'normalized_rmse':float(np.sqrt(np.mean((got[...,1]-ref[...,1])**2))/ref[...,1].mean())}})
        result['box_filter_operator_comparison'][cname]=tests
        print('box BRDF done',key,cname,flush=True)
    del shaded,filtered,got,ref
    gc.collect()
    # Match current blend topology over the actual 641 x 14 metre road domain.
    uv=RNG.uniform([0,0],[641/size_m,14/size_m],size=(N_SAMPLES,2))
    suv,w=coordinates(uv)
    result['random_mixing']={'sample_count':N_SAMPLES,'seed':SEED,
        'domain_m':[641,14],'weights_square_sum':stats(np.sum(w*w,axis=1)),'levels':[]}
    mip=p
    for level in range(7):
        if level: mip=block(mip,2)
        if level not in [0,2,4,6]: continue
        base=sample(mip,uv)
        candidates=np.stack([sample(mip,suv[:,j,:]) for j in range(3)],axis=1)
        mixed=np.sum(candidates*w[:,:,None],axis=1)
        variants={'plain':base,'all_mixed':mixed}
        for name,sl in [('color_only',slice(0,3)),('normal_only',slice(3,6)),('roughness_only',slice(6,7))]:
            q=base.copy();q[:,sl]=mixed[:,sl];variants[name]=q
        item={'lod':level,'effective_square_texel_mm':size_m*1000*2**level/4096,
            'map_stats':{name:sample_summary(q) for name,q in variants.items()},'direct_shading':{}}
        for cname,case in CASES.items():
            channels={}
            for name,q in variants.items():
                sh=shade(q,case)
                channels[name]={'diffuse':stats(sh[:,0]),'specular':stats(sh[:,1])}
            # Shading then blending the same three candidates is an operator
            # reference for the blend; not the true microscopic construction.
            candidate_shading=sum(shade(candidates[:,j,:],case)*w[:,j,None] for j in range(3))
            channels['blend_after_shading']={'diffuse':stats(candidate_shading[:,0]),'specular':stats(candidate_shading[:,1])}
            item['direct_shading'][cname]=channels
        result['random_mixing']['levels'].append(item)
        print('random mix done',key,level,flush=True)
    (OUT/f'{key}-measurements.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    del p,mip
    gc.collect()
    print('DONE',key,flush=True)


if __name__=='__main__':
    OUT.mkdir(exist_ok=True,parents=True)
    (OUT/'method.json').write_text(json.dumps({'source':'local original 4K scans, current source; no attachment code executed',
        'random_seed':SEED,'samples_per_material':N_SAMPLES,'direct_cases':CASES,
        'limitations':['CPU reference, not GPU frame or exact WebGL mip/AF implementation',
            'box averages are controlled footprints; no claim that hardware uses these exact boxes',
            'normal map renormalization, GGX correlated visibility and Fresnel fit match r180 direct branch',
            'unit light, no IBL/visibility/tone mapping; no attribution of full game image percentage',
            'sample hash float64 CPU sin is not bit-identical to GPU float sin',
            'radiance-average reference measures order-of-operations error for this shader, not physical asphalt truth',
            'height-gradient sign checks are evidence of map consistency, not official normal-space metadata']},indent=2),encoding='utf-8')
    analyze('asphalt','fine_asphalt_vlzobiady_4k.zip',3.)
    analyze('fresh','asphalt_fresh_sfrofg0a_4k.zip',2.)
