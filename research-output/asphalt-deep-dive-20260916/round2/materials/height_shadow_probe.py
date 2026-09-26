"""Conditional height-field visibility reference, not real-asphalt ground truth.

Uses only original height images. No copied external executable code. Public
Unity micro-shadow formula is re-expressed as a numerical candidate with fixed
opacity=1, never fitted to these visibility results.
"""
import json,math
import numpy as np
from height_consistency import OUT,SOURCES,read_source,gradient,height_n,stats,corr

PATCHES=[(512,512),(1536,1536),(2560,2560),(3456,3456)]
PATCH_SIZE=128
AZIMUTHS=np.arange(16)*2*np.pi/16
ELEVATIONS=[10.,20.,48.,70.]

def sample_height(h,x,y):
    xi=np.floor(x).astype(np.int32);yi=np.floor(y).astype(np.int32)
    fx=x-xi;fy=y-yi
    return ((h[yi%4096,xi%4096]*(1-fx)+h[yi%4096,(xi+1)%4096]*fx)*(1-fy)
           +(h[(yi+1)%4096,xi%4096]*(1-fx)+h[(yi+1)%4096,(xi+1)%4096]*fx)*fy)

def get_horizon(h,x,y,spacing,azimuths,dense=False):
    if dense:
        distances=np.r_[np.arange(.125,16,.125),np.arange(16,128,.25),np.geomspace(128,1536,128)]
    else:
        distances=np.r_[np.arange(.25,8,.25),np.arange(8,64,.5),np.geomspace(64,1536,64)]
    h0=sample_height(h,x,y)
    result=[]
    for phi in azimuths:
        maximum=np.zeros(len(x),np.float64)
        for d in distances:
            other=sample_height(h,x+d*np.cos(phi),y-d*np.sin(phi))
            maximum=np.maximum(maximum,(other-h0)/(d*spacing))
        result.append(maximum.astype(np.float32))
    return np.stack(result,axis=1)

def derived_ao(horizon,n,scale):
    # Cosine-weighted integral of visibility above the geometric horizon around
    # the local height-field normal, analytic elevation integral, 16 azimuths.
    a=n[:,0,None]*np.cos(AZIMUTHS)+n[:,1,None]*np.sin(AZIMUTHS)
    beta=np.maximum(np.arctan(scale*horizon),np.arctan(np.maximum(-a,0)/np.maximum(n[:,2,None],1e-9)))
    integrand=a*(np.pi/4-beta/2-np.sin(2*beta)/4)+n[:,2,None]*.5*np.cos(beta)**2
    return np.clip(2*integrand.mean(axis=1),0,1).astype(np.float32)

def filtered(x,size):
    return x.reshape(4,PATCH_SIZE//size,size,PATCH_SIZE//size,size).mean(axis=(2,4))

def metrics(pred,ref):
    rm=float(ref.mean())
    out={'mean':float(pred.mean()),'relative_mean_bias':float(pred.mean()/max(rm,1e-9)-1),
         'rmse':float(np.sqrt(np.mean((pred-ref)**2))),
         'normalized_rmse':float(np.sqrt(np.mean((pred-ref)**2))/max(rm,1e-9))}
    for width in [8,16]:
        a,b=filtered(pred,width),filtered(ref,width)
        out[f'box{width}_normalized_rmse']=float(np.sqrt(np.mean((a-b)**2))/max(rm,1e-9))
    return out

def proxy(ao,nl):
    # Unity CommonLighting ComputeMicroShadowing AO aperture approximation.
    return np.clip(nl+2*ao*ao-1,0,1)

def run():
    consistency=json.loads((OUT/'height-normal-consistency.json').read_text())
    result={'method':{'patches_image_xy':PATCHES,'patch_size':PATCH_SIZE,
        'texel_centers':4*PATCH_SIZE**2,'azimuth_count':16,'elevation_degrees':ELEVATIONS,
        'reference':'single-bounce directional diffuse irradiance N_height dot L * binary height-field visibility; no material/IBL/multiple scatter/BRDF',
        'important':'All scales conditional; neither metadata.height applicability nor normal-fit height is independently metrological. Not production rendering.',
        'periodic_surface':True,'ray_range_texels':1536,
        'candidate':'fixed public AO micro-shadow function clamp(NdotL + 2*AO^2 - 1), opacity=1; no tuning',
        'official_formula_source':'https://github.com/Unity-Technologies/Graphics/blob/master/Packages/com.unity.render-pipelines.core/ShaderLibrary/CommonLighting.hlsl',
        'source_AO_effective':'0.4 + 0.6*source AO, corresponding to current AO intensity but not assuming this is the right micro-shadow authoring convention'},'assets':{}}
    xs=[];ys=[]
    for px,py in PATCHES:
        xx,yy=np.meshgrid(np.arange(px,px+PATCH_SIZE),np.arange(py,py+PATCH_SIZE))
        xs.append(xx.ravel());ys.append(yy.ravel())
    x=np.concatenate(xs).astype(np.float64);y=np.concatenate(ys).astype(np.float64)
    for key,fn,width,metaheight in SOURCES:
        meta,maps=read_source(fn)
        ns=maps['Normal'][y.astype(int),x.astype(int)]
        ao=maps['AO'][y.astype(int),x.astype(int)]
        asset={}
        for ch in ['Bump','Displacement']:
            if ch not in maps:continue
            print('horizon',key,ch,flush=True)
            h=maps[ch];spacing=width/4096
            horizon=get_horizon(h,x,y,spacing,AZIMUTHS)
            gx,gy=gradient(h,y.astype(int),x.astype(int))
            fit=consistency[key]['maps'][ch]['fits'][0]['best_angular_scale_m']
            scales={'metadata_height_as_full_range':metaheight,'normal_fit_full_range':fit}
            if ch=='Displacement':scales['displacementScale_if_centimeters']=float(meta['displacementScale'])*.01
            records=[]
            dense=get_horizon(h,x[::16],y[::16],spacing,AZIMUTHS[:4],dense=True)
            for label,scale in scales.items():
                print('cases',key,ch,label,flush=True)
                nh=height_n(gx,gy,scale,spacing)
                aoh=derived_ao(horizon,nh,scale)
                convergence={}
                for el in ELEVATIONS:
                    a=scale*horizon[::16,:4]<=np.tan(np.radians(el))
                    b=scale*dense<=np.tan(np.radians(el))
                    convergence[str(el)]=float((a!=b).mean())
                record={'label':label,'height_range_scale_m':scale,
                    'height_normal_angular_difference_degrees':stats(np.degrees(np.arccos(np.clip((nh*ns).sum(axis=1),-1,1)))),
                    'derived_ao':stats(aoh),'source_ao':stats(ao),'derived_vs_source_AO_corr':corr(aoh,ao),
                    'denser_ray_visibility_disagreement':convergence,'rows':[]}
                for el in ELEVATIONS:
                    sinel,cosel=np.sin(np.radians(el)),np.cos(np.radians(el))
                    for i,phi in enumerate(AZIMUTHS):
                        l=np.array([cosel*np.cos(phi),cosel*np.sin(phi),sinel])
                        nlh=np.clip(nh@l,0,1);nls=np.clip(ns@l,0,1)
                        visibility=(scale*horizon[:,i]<=np.tan(np.radians(el))).astype(np.float32)
                        ref=nlh*visibility
                        candidates={
                            'height_normal_no_occlusion':nlh,
                            'source_normal_no_occlusion':nls,
                            'source_AO_times_source_NL':nls*ao,
                            'micro_source_AO_source_normal':nls*proxy(ao,nls),
                            'micro_effective_AO_source_normal':nls*proxy(.4+.6*ao,nls),
                            'micro_source_AO_height_normal':nlh*proxy(ao,nlh),
                            'micro_derived_AO_height_normal':nlh*proxy(aoh,nlh),
                        }
                        record['rows'].append({'elevation':el,'azimuth_degrees':float(np.degrees(phi)),
                            'visibility_mean':float(visibility.mean()),'reference_mean':float(ref.mean()),
                            'blocked_fraction_among_facing_height_normals':float(np.mean(visibility[nlh>0]==0)),
                            'candidates':{name:metrics(pred,ref) for name,pred in candidates.items()}})
                records.append(record)
            asset[ch]={'records':records}
        result['assets'][key]=asset
        (OUT/'height-shadow-comparison.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print('done')

if __name__=='__main__':run()
