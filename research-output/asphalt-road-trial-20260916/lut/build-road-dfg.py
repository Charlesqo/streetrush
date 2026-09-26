"""Independent, full-domain road DFG LUT. No attachment code is imported.

Heitz GGX VNDF sampling + height-correlated Smith G2/G1 importance weights.
Fresnel uses Three r180's exp2 approximation, not pow(1-VoH,5).
Analytic r=0 mirror limit; Nv=0 evaluates the positive-grazing limit at 1e-5.
The stable analytic model does not impose GLSL's numerical visibility EPS floor.
"""
from pathlib import Path
import argparse, base64, hashlib, json, time
import numpy as np
from numpy.polynomial.legendre import leggauss

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
NV_EPS=1e-5

def points(power,seed):
    n=2**power; idx=np.arange(n,dtype=np.uint32); bits=idx.copy()
    bits=(bits<<np.uint32(16))|(bits>>np.uint32(16))
    for shift,mask in [(1,0x55555555),(2,0x33333333),(4,0x0f0f0f0f),(8,0x00ff00ff)]:
        s=np.uint32(shift);m=np.uint32(mask)
        bits=((bits&m)<<s)|((bits>>s)&m)
    u=np.stack([(idx.astype(np.float64)+.5)/n,bits.astype(np.float64)*2.3283064365386963e-10],axis=1)
    u=(u+np.random.default_rng(seed).uniform(0,1,2))%1
    radius=np.sqrt(u[:,0]); angle=2*np.pi*u[:,1]
    t1=radius*np.cos(angle); t2=radius*np.sin(angle)
    return t1,t2,np.sqrt(np.maximum(0,1-t1*t1))

def integrate(r,nvs,p,clamp_epsilon=False):
    nvs=np.asarray(nvs,dtype=np.float64)
    if r==0:
        fc=np.exp2((-5.55473*nvs-6.98316)*nvs)
        return np.stack([1-fc,fc],axis=-1)
    nv=np.maximum(nvs,NV_EPS)[:,None]; vx=np.sqrt(np.maximum(0,1-nv*nv))
    alpha=r*r; a2=alpha*alpha
    stretch=np.sqrt(a2*vx*vx+nv*nv)
    vhx=alpha*vx/stretch; vhz=nv/stretch
    t1,t2base,t1edge=p; s=.5*(1+vhz)
    t2=(1-s)*t1edge+s*t2base
    t3=np.sqrt(np.maximum(0,1-t1*t1-t2*t2))
    hx=alpha*(-vhz*t2+vhx*t3); hy=alpha*t1
    hz=np.maximum(0,vhx*t2+vhz*t3)
    invlen=1/np.sqrt(hx*hx+hy*hy+hz*hz)
    voh=np.clip((vx*hx+nv*hz)*invlen,0,1)
    nl=2*voh*hz*invlen-nv
    sv=np.sqrt(a2+(1-a2)*nv*nv)
    sl=np.sqrt(a2+(1-a2)*nl*nl)
    # Algebraically G2(V,L)/G1(V), avoiding division by Nv at grazing views.
    denom=nl*sv+nv*sl
    if clamp_epsilon: denom=np.maximum(denom,1e-6)
    weight=np.where(nl>0,np.maximum(nl,0)*(nv+sv)/np.maximum(denom,1e-30),0)
    fc=np.exp2((-5.55473*voh-6.98316)*voh)
    return np.stack([np.mean(weight*(1-fc),axis=1),np.mean(weight*fc,axis=1)],axis=-1)

def sphere_reference(r,nv,order=320):
    # Independent incoming-direction quadrature, useful for broad lobes.
    x,w=leggauss(order); nl=(x+1)/2; w=w/2
    phi=(np.arange(order*2)+.5)*np.pi/order
    vl=np.sqrt(1-nv*nv)*np.sqrt(1-nl[:,None]**2)*np.cos(phi)+nv*nl[:,None]
    hn=(nl[:,None]+nv)/np.sqrt(2+2*vl); vh=np.sqrt((1+vl)/2)
    a2=r**4
    D=a2/(np.pi*(1+(a2-1)*hn*hn)**2)
    Vis=.5/np.maximum(nl[:,None]*np.sqrt(a2+(1-a2)*nv*nv)+nv*np.sqrt(a2+(1-a2)*nl[:,None]**2),1e-6)
    fac=D*Vis*nl[:,None]*w[:,None]*np.pi/order
    fc=np.exp2((-5.55473*vh-6.98316)*vh)
    return np.array([np.sum(fac*(1-fc)),np.sum(fac*fc)])

def sample(table,nv,r):
    height,width,_=table.shape
    x=np.sqrt(np.clip(nv,0,1))*(width-1);y=np.clip(r,0,1)*(height-1)
    a,b=int(np.floor(x)),int(np.floor(y));fx,fy=x-a,y-b
    a1,b1=min(a+1,width-1),min(b+1,height-1)
    return (1-fy)*((1-fx)*table[b,a]+fx*table[b,a1])+fy*((1-fx)*table[b1,a]+fx*table[b1,a1])

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--size',type=int,default=256);parser.add_argument('--sample-power',type=int,default=13)
    args=parser.parse_args();size=args.size;start=time.perf_counter()
    rs=np.linspace(0,1,size);nvs=np.linspace(0,1,size)**2
    p=points(args.sample_power,20260916);table=np.empty((size,size,2),dtype=np.float64)
    for j,r in enumerate(rs):
        for a in range(0,size,32): table[j,a:a+32]=integrate(float(r),nvs[a:a+32],p)
        if j%32==0: print(f'generated row {j}/{size}',flush=True)
    assert np.isfinite(table).all() and table.min()>=0 and np.max(table.sum(-1))<=1+1e-12
    packed=table.astype('<f2')
    # Independent half rounding can otherwise make A+B slightly exceed one.
    over=packed.astype(np.float64).sum(-1)>1
    corrections=int(over.sum())
    while np.any(over):
        largest=np.argmax(packed,axis=-1)
        for c in (0,1):
            mask=over&(largest==c)
            packed[...,c][mask]=np.nextafter(packed[...,c][mask],np.float16(0))
        over=packed.astype(np.float64).sum(-1)>1
    decoded=packed.astype(np.float64)
    # Independently scrambled higher-count holdout references.
    refp=points(19,83051);refp2=points(18,17193)
    testpts=[(nv,r) for nv in [0,1e-5,1e-4,.001,.005,.025,.1,.5,1] for r in [0,.005,.01,.025,.0525,.1,.3,.6,.837,1]]
    rng=np.random.default_rng(81732)
    testpts += list(zip(rng.uniform(0,1,64),rng.uniform(0,1,64)))
    rows=[]
    for nv,r in testpts:
        ref=integrate(float(r),[nv],refp)[0];ref2=integrate(float(r),[nv],refp2)[0];lut=sample(decoded,nv,r)
        value=lambda ab:float(.04*ab[0]+ab[1])
        row={'Nv':float(nv),'roughness':float(r),'referenceAB':ref.tolist(),'lutAB':lut.tolist(),'referenceSingleF004':value(ref),'lutSingleF004':value(lut),
             'absoluteError':value(lut)-value(ref),'relativeError':value(lut)/max(value(ref),1e-12)-1,
             'referenceScrambleRelativeDifference':(value(ref2)-value(ref))/max(value(ref),1e-12),
             'maxAbsABError':float(np.max(np.abs(lut-ref)))}
        rows.append(row)
    broad=[]
    for nv in [1,.5,.1,.025]:
        ref=sphere_reference(.837,nv);est=integrate(.837,[nv],refp)[0]
        broad.append({'Nv':nv,'roughness':.837,'sphereAB':ref.tolist(),'vndfAB':est.tolist(),'lutAB':sample(decoded,nv,.837).tolist(),
                      'vndfSingleRelativeError':float((.04*est[0]+est[1])/(.04*ref[0]+ref[1])-1)})
    # Literal shader EPS is a numerical guard, not part of the analytic model.
    guards=[]
    for r,nv in [(.0525,.001),(.0525,1e-5),(.837,1e-5),(.837,.025)]:
        a=integrate(r,[nv],refp)[0];b=integrate(r,[nv],refp,True)[0]
        guards.append({'roughness':r,'Nv':nv,'analyticAB':a.tolist(),'literalVisibilityEpsilonAB':b.tolist()})
    material_rows=[q for q in rows if q['roughness']>=.0525 and q['Nv']>=.001]
    rough_rows=[q for q in rows if q['roughness']>=.6]
    stats=lambda qq:{'points':len(qq),'maxAbsSingleError':max(abs(q['absoluteError']) for q in qq),'maxAbsRelativeSingleError':max(abs(q['relativeError']) for q in qq),'maxAbsABError':max(q['maxAbsABError'] for q in qq),'maxReferenceScrambleRelativeDifference':max(abs(q['referenceScrambleRelativeDifference']) for q in qq)}
    validation={'status':'CPU_VALIDATED_TRIAL_NOT_GPU_ACCEPTED','allDiscretePoints':stats(rows),'roadPracticalDiscretePoints_r_ge_00525_Nv_ge_0001':stats(material_rows),'highRoughnessDiscretePoints_r_ge_06':stats(rough_rows),
                'allTexelsFinite':bool(np.isfinite(decoded).all()),'minimumAB':float(decoded.min()),'maximumAB':float(decoded.max()),'maximumEss':float(decoded.sum(-1).max()),'minimumEss':float(decoded.sum(-1).min()),
                'halfEnergyCorrections':corrections,'maxHalfQuantizationAbsAB':float(np.max(np.abs(decoded-table))),
                'sphereCrossCheck':broad,'numericalGuardDifferences':guards,'holdout':rows,'elapsedSeconds':time.perf_counter()-start}
    blob=packed.tobytes();digest=hashlib.sha256(blob).hexdigest()
    payload={'version':'streetrush-road-dfg-v1','threeRevision':'180','status':'development-trial; CPU validated, GPU integration pending',
             'width':size,'height':size,'channels':['A','B'],'type':'float16','byteOrder':'little-endian','encoding':'base64','format':'RG16F','byteLength':len(blob),'sha256':digest,
             'domain':{'NdotV':[0,1],'perceptualRoughness':[0,1]},
             'grid':{'x':'sqrt(NdotV)','y':'perceptualRoughness','endpointsAtTexelCenters':True,'rowOrder':'roughness increasing from row zero','flipY':False},
             'lookupGLSL':f'vec2 coord=vec2(sqrt(clamp(dot(normal,viewDir),0.0,1.0)),clamp(roughness,0.0,1.0)); vec2 uv=(coord*vec2({size-1}.0)+0.5)/vec2({size}.0); return texture2D(roadDFGLut,uv).rg;',
             'sampling':{'minFilter':'LinearFilter','magFilter':'LinearFilter','wrapS':'ClampToEdgeWrapping','wrapT':'ClampToEdgeWrapping','generateMipmaps':False,'colorSpace':'NoColorSpace'},
             'model':{'distribution':'isotropic GGX','alpha':'perceptualRoughness squared','visibility':'height-correlated Smith','fresnel':'exp2((-5.55473*VoH-6.98316)*VoH)','combination':'F0*A + F90*B; coefficients are single scattering; retain existing r180 multiple scattering',
                      'roughnessZero':'analytic smooth-mirror limit','NdotVZero':f'evaluate positive grazing limit at {NV_EPS}, except exact mirror corner uses Fresnel limit',
                      'numericalGuard':'Stable analytic VNDF ratio; excludes direct-light GLSL EPSILON=1e-6 denominator floor. Differences quantified in validation; no legacy-domain fallback.'},
             'generation':{'method':'Heitz 2018 VNDF + correlated G2/G1; independently shifted Hammersley','samplesPerTexel':2**args.sample_power,'seed':20260916,'precision':'float64 then constrained IEEE float16','referenceSamples':2**19},
             'validationSummary':{k:v for k,v in validation.items() if k not in ['holdout','sphereCrossCheck','numericalGuardDifferences']},
             'base64':base64.b64encode(blob).decode('ascii')}
    (HERE/'road-dfg-rg16f.bin').write_bytes(blob)
    (HERE/'road-dfg-validation.json').write_text(json.dumps(validation,indent=2),encoding='utf8')
    text=json.dumps(payload,ensure_ascii=False,separators=(',',':'))
    (HERE/'road-dfg-lut.json').write_text(text,encoding='utf8')
    destination=ROOT/'src/data/road-dfg-lut.json';destination.parent.mkdir(exist_ok=True);destination.write_text(text,encoding='utf8')
    print(json.dumps(payload['validationSummary'],indent=2),flush=True)
    print('wrote',destination,'bytes',len(blob),'sha',digest,flush=True)

if __name__=='__main__': main()
