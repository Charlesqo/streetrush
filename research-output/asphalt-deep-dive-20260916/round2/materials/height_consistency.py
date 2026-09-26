"""Read-only height / normal compatibility; scales are diagnostic, not truth."""
from pathlib import Path
import io,json,zipfile
import numpy as np
from PIL import Image

OUT=Path(__file__).resolve().parent
ROOT=OUT.parents[3]
DOWNLOADS=ROOT.parent/'Megascans_已拥有/已下载'
SOURCES=[('asphalt','fine_asphalt_vlzobiady_4k.zip',3.,.009),('fresh','asphalt_fresh_sfrofg0a_4k.zip',2.,.027)]

def read_source(fn):
    with zipfile.ZipFile(DOWNLOADS/fn) as z:
        meta=json.loads(z.read(next(n for n in z.namelist() if n.endswith('.json'))))
        maps={}
        for ch in ['Bump','Displacement','Normal','AO','Cavity']:
            names=[n for n in z.namelist() if n.lower().endswith('_'+ch.lower()+'.jpg')]
            if names:
                im=Image.open(io.BytesIO(z.read(names[0])))
                maps[ch]=np.array(im if ch=='Normal' else im.convert('L'),np.float32)/255
    maps['Normal']=maps['Normal']*2-1
    maps['Normal']/=np.maximum(np.linalg.norm(maps['Normal'],axis=-1,keepdims=True),1e-9)
    return meta,maps

def stats(x):
    return {'mean':float(np.mean(x,dtype=np.float64)),'std':float(np.std(x,dtype=np.float64)),
        'p01_p10_p50_p90_p99':np.quantile(x,[.01,.1,.5,.9,.99]).tolist()}

def corr(a,b):return float(np.corrcoef(a.ravel(),b.ravel())[0,1])

def gradient(h,y,x,step=1,method='central'):
    if method=='central':
        gx=(h[y,x+step]-h[y,x-step])/(2*step)
        gy=(h[y+step,x]-h[y-step,x])/(2*step)
    else:
        gx=((h[y-1,x+1]-h[y-1,x-1])+2*(h[y,x+1]-h[y,x-1])+(h[y+1,x+1]-h[y+1,x-1]))/8
        gy=((h[y+1,x-1]-h[y-1,x-1])+2*(h[y+1,x]-h[y-1,x])+(h[y+1,x+1]-h[y-1,x+1]))/8
    return gx,gy

def height_n(gx,gy,scale,spacing):
    n=np.stack([-scale*gx/spacing,scale*gy/spacing,np.ones_like(gx)],axis=-1)
    return n/np.linalg.norm(n,axis=-1,keepdims=True)

def angle(a,b):return np.degrees(np.arccos(np.clip(np.sum(a*b,axis=-1),-1,1)))

def analyze():
    OUT.mkdir(exist_ok=True,parents=True)
    result={}
    rng=np.random.default_rng(716)
    yy=rng.integers(20,4076,160000);xx=rng.integers(20,4076,160000)
    for key,fn,size,metaheight in SOURCES:
        print(key,flush=True)
        meta,maps=read_source(fn)
        n=maps['Normal'][yy,xx]
        z={'scan_width_m':size,'metadata_height_m':metaheight,
           'displacement_metadata':{k:meta[k] for k in ['displacementBias','displacementScale','displacementCalibrationAccuracy']},
           'metadata_warning':'No official schema/unit found for displacementScale, Bias, CalibrationAccuracy. height is labelled meters; applying it to Bump is not established.',
           'maps':{},'fit_method':'160000 fixed random pixels; minimize mean angular error to normalized source Normal; positive scale search, physical UV spacing. This is an internal consistency fit, NOT metrology.'}
        for ch in ['Bump','Displacement']:
            if ch not in maps:continue
            h=maps[ch]
            data={'raw_normalized_height':stats(h),'ao_correlation':corr(h[::4,::4],maps['AO'][::4,::4]),'fits':[]}
            for method,step in [('central',1),('central',2),('central',4),('sobel',1)]:
                gx,gy=gradient(h,yy,xx,step,method)
                samples=[]
                scales=np.geomspace(.0001,.12,90)
                for s in scales:
                    hn=height_n(gx,gy,s,size/4096)
                    samples.append(float(angle(hn,n).mean()))
                best=int(np.argmin(samples)); s=float(scales[best]);hn=height_n(gx,gy,s,size/4096)
                valid=n[:,2]>.2
                sx=-n[valid,0]/n[valid,2];sy=n[valid,1]/n[valid,2]
                g=np.r_[gx[valid],gy[valid]]/(size/4096);slope=np.r_[sx,sy]
                fit=float(np.dot(g,slope)/np.dot(g,g))
                data['fits'].append({'method':method,'step_px':step,'best_angular_scale_m':s,
                    'best_angular_error_degrees':stats(angle(hn,n)),
                    'metadata_height_angular_error_degrees':stats(angle(height_n(gx,gy,metaheight,size/4096),n)),
                    'corr_Nx_minus_dHdx':corr(n[:,0],-gx),'corr_Ny_plus_dHdy':corr(n[:,1],gy),
                    'slope_l2_scale_m_Nz_gt_0_2':fit,'slope_correlation_Nz_gt_0_2':corr(g,slope),
                    'scale_grid_m':scales.tolist(),'mean_angle_grid_degrees':samples})
            # Translation check: normal and height derivative correlation should
            # peak at zero offset if maps align (subpixel bake differences remain).
            align=[]
            for dy,dx in [(0,0),(0,1),(0,-1),(1,0),(-1,0),(0,2),(0,-2),(2,0),(-2,0)]:
                gx,gy=gradient(h,yy+dy,xx+dx)
                align.append({'offset_image_xy':[dx,dy],'corr_x':corr(n[:,0],-gx),'corr_y':corr(n[:,1],gy)})
            data['alignment_tests']=align
            z['maps'][ch]=data
        if 'Displacement' in maps:
            z['bump_displacement_correlation']=corr(maps['Bump'][::4,::4],maps['Displacement'][::4,::4])
            z['bump_displacement_low_frequency_correlation']={}
            for block in [4,16,64]:
                a=maps['Bump'].reshape(4096//block,block,4096//block,block).mean((1,3))
                b=maps['Displacement'].reshape(4096//block,block,4096//block,block).mean((1,3))
                z['bump_displacement_low_frequency_correlation'][str(block)]=corr(a,b)
        result[key]=z
    (OUT/'height-normal-consistency.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print('done')

if __name__=='__main__':analyze()
