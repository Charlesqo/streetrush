"""Additional read-only scale / file-format checks, no texture outputs."""
from pathlib import Path
import gc
import json
import numpy as np
from PIL import Image, JpegImagePlugin

OUT=Path(__file__).resolve().parent
ROOT=OUT.parents[2]
ASSETS=ROOT/'scratch/straight-art-20260916/assets'

def spectrum(x,size_m):
    x=np.asarray(x,dtype=np.float32);x=x-x.mean()
    f=np.fft.rfft2(x)
    power=np.abs(f)**2
    power[:,1:-1]*=2
    total=float(power.sum(dtype=np.float64))
    radius=np.sqrt(np.fft.fftfreq(x.shape[0])[:,None]**2+np.fft.rfftfreq(x.shape[1])[None,:]**2)
    result={'variance':float(np.var(x,dtype=np.float64)), 'power_fraction_below_wavelength_mm':{}}
    for mm in [1,2,3,5,10,20,50,100,250,500]:
        threshold=(size_m*1000/x.shape[1])/mm
        result['power_fraction_below_wavelength_mm'][str(mm)]=float(power[radius>threshold].sum(dtype=np.float64)/total)
    for px in [2,4,8,16,32,64]:
        result[f'power_fraction_wavelength_lt_{px}px']=float(power[radius>1/px].sum(dtype=np.float64)/total)
    return result

report={}
for key,size in [('asphalt',3.),('fresh',2.)]:
    print(key,flush=True)
    channels={}
    n=np.array(Image.open(ASSETS/key/'Normal.jpg'),np.float32)/127.5-1
    for i,ch in enumerate(['normal_x','normal_y']):
        channels[ch]=spectrum(n[...,i],size)
    del n;gc.collect()
    c=np.array(Image.open(ASSETS/key/'BaseColor.jpg'),np.float32)/255
    c=np.where(c<=.04045,c/12.92,((c+.055)/1.055)**2.4)
    y=c@[.2126,.7152,.0722];del c
    channels['linear_luma']=spectrum(y,size)
    del y;gc.collect()
    r=np.array(Image.open(ASSETS/key/'Roughness.jpg').convert('L'),np.float32)/255
    channels['roughness']=spectrum(r,size)
    jpeg={}
    for ch in ['Normal','BaseColor','Roughness','AO']:
        im=Image.open(ASSETS/key/(ch+'.jpg'))
        qt=im.quantization
        jpeg[ch]={'subsampling':JpegImagePlugin.get_sampling(im),
                  'quantization_min_max':{str(k):[min(v),max(v)] for k,v in qt.items()},
                  'meaning':'sampling 0=4:4:4, 1=4:2:2, 2=4:2:0; does not recover prior authoring/export losses'}
    report[key]={'scan_size_m':size,'method':'Full 4096x4096 periodic DFT, DC removed; power-weighted radial wavelength, no window because tileable source',
                 'warning':'Power at a wavelength is not physical feature diameter; edge mismatch may leak low-frequency signal. No claim of final-screen visibility.',
                 'channels':channels,'jpeg':jpeg}
    del r;gc.collect()
(OUT/'spectral-measurements.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print('done')
