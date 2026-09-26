"""Condition the real scan blend contrast on triangle weights (CPU evidence)."""
import json
import numpy as np
from PIL import Image
from analyze_materials import ASSETS,OUT,sample,coordinates,block,srgb_to_linear

result={}
for key,size in [('asphalt',3.),('fresh',2.)]:
    c=srgb_to_linear(np.array(Image.open(ASSETS/key/'BaseColor.jpg'),np.float32)/255)
    p=(c@[.2126,.7152,.0722]).astype(np.float32)[...,None];del c
    rng=np.random.default_rng(2049)
    uv=rng.uniform([0,0],[641/size,14/size],size=(600000,2))
    coords,w=coordinates(uv);square=(w*w).sum(axis=1)
    levels=[]
    for level in range(5):
        if level:p=block(p,2)
        if level not in [0,4]:continue
        orig=sample(p,uv)[:,0]
        mixed=sum(sample(p,coords[:,j,:])[:,0]*w[:,j] for j in range(3))
        bins=[]
        for lo,hi in [(.3333,.45),(.45,.6),(.6,.75),(.75,.9),(.9,1.00001)]:
            keep=(square>=lo)&(square<hi)
            bins.append({'sum_weights_squared_range':[lo,hi],'count':int(keep.sum()),
                'mean_sum_weights_squared':float(square[keep].mean()),
                'mixed_luma_mean':float(mixed[keep].mean()),
                'mixed_luma_std':float(mixed[keep].std()),
                'unmixed_luma_std':float(orig[keep].std()),
                'std_ratio_mixed_to_unmixed':float(mixed[keep].std()/orig[keep].std())})
        levels.append({'lod':level,'bins':bins})
    result[key]={'domain_m':[641,14],'samples':600000,'levels':levels,
        'lattice_vectors_m':[[size,0],[.5*size,.8660254*size]],
        'caveat':'Statistics conditioned on weights over many cells, not proof that the visible in-game squares are this lattice. Random shifts sample different positions.'}
(OUT/'blend-weight-conditioned.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print('done')
