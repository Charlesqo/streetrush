"""Independent read-only HDR / linear BRDF audit; no game or attachment imports.
Matches r180 HDRLoader's RGBE division by 255, then float16 texture storage.
Integrates texel-centre radiance with exact latlong cell solid angles.
This is a sky-only CPU reference, not a rendered venue PMREM or lux measurement.
"""
from pathlib import Path
import hashlib, json, math
import numpy as np

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
SRC = ROOT / 'public/textures/sky/kloofendal_48d_partly_cloudy_puresky_2k.hdr'
LUMA = np.array([.2126, .7152, .0722])

def read_rgbe(path):
    with path.open('rb') as f:
        header=[]
        while True:
            line=f.readline()
            if not line: raise ValueError('Missing RGBE resolution')
            header.append(line.decode('ascii').rstrip())
            if line.startswith(b'-Y '):
                _,hs,_,ws=line.split(); h,w=int(hs),int(ws); break
        data=np.empty((h,w,4),dtype=np.uint8)
        for row in range(h):
            assert f.read(4)==bytes([2,2,w>>8,w&255])
            for channel in range(4):
                x=0
                while x<w:
                    code=f.read(1)[0]
                    if code>128:
                        n=code-128; value=f.read(1)[0]
                        data[row,x:x+n,channel]=value
                    else:
                        n=code; assert n>0
                        data[row,x:x+n,channel]=np.frombuffer(f.read(n),dtype=np.uint8)
                    x+=n
                assert x==w
        assert not f.read(1)
    rgb=data[...,:3].astype(np.float64)*np.exp2(data[...,3].astype(np.float64)-128)[...,None]/255
    return rgb,header

def srgb(rgb):
    c=np.asarray(rgb)/255
    return np.where(c<=.04045,c/12.92,((c+.055)/1.055)**2.4)

def integrate_pair(a,b,weight):
    x=(a*weight[:,None]).sum(axis=0); y=(b*weight[:,None]).sum(axis=0)
    return {'raw_rgb':x.tolist(),'clipped_rgb':y.tolist(),
            'raw_luma':float(x@LUMA),'clipped_luma':float(y@LUMA),
            'loss_fraction_luma':float(1-y@LUMA/(x@LUMA))}

def response(lights,view,r):
    nl=np.maximum(lights[:,1],0); nv=view[1]
    vh_dot=lights@view
    hlen=np.sqrt(np.maximum(2+2*vh_dot,1e-20))
    nh=(lights[:,1]+nv)/hlen
    vh=np.sqrt(np.maximum((1+vh_dot)/2,0))
    a2=r**4
    D=a2/(np.pi*(1+(a2-1)*nh*nh)**2)
    Vis=.5/np.maximum(nl*np.sqrt(a2+(1-a2)*nv*nv)+nv*np.sqrt(a2+(1-a2)*nl*nl),1e-6)
    F=.04+.96*np.exp2((-5.55473*vh-6.98316)*vh)
    return np.where(nl>0,nl*D*Vis*F,0)

def main():
    rgb,header=read_rgbe(SRC); h,w,_=rgb.shape
    # The application uses HDRLoader's default HalfFloatType.
    # DataUtils.toHalfFloat truncates the mantissa, whereas NumPy rounds to nearest.
    capped32=np.minimum(rgb,65504).astype(np.float32)
    half_bits=capped32.astype(np.float16).view(np.uint16)
    half_bits-=((half_bits.view(np.float16).astype(np.float32)>capped32)&(half_bits>0)).astype(np.uint16)
    half=half_bits.view(np.float16).astype(np.float64)
    row=(np.arange(h)+.5)/h; col=(np.arange(w)+.5)/w
    elev=np.pi*(.5-row); az=2*np.pi*(col-.5)-1.1
    dirs=np.stack(np.broadcast_arrays(np.cos(elev)[:,None]*np.cos(az)[None,:],
                    np.sin(elev)[:,None]+np.zeros((1,w)),
                    np.cos(elev)[:,None]*np.sin(az)[None,:]),axis=-1).reshape(-1,3)
    drow=(np.sin(np.pi*(.5-np.arange(h)/h))-np.sin(np.pi*(.5-(np.arange(h)+1)/h)))
    omega=np.repeat(drow*2*np.pi/w,w)
    raw=half.reshape(-1,3); clipped=np.minimum(raw,8); loss=raw-clipped
    y=raw@LUMA; maxindex=int(np.argmax(y)); sy,sx=divmod(maxindex,w)
    # Use the source code's measured solar texel, independently compare the maximum.
    sun_elev=np.pi*(.5-239.5/1024); sun_az=2*np.pi*(1218.5/2048-.5)-1.1
    sun=np.array([np.cos(sun_elev)*np.cos(sun_az),np.sin(sun_elev),np.cos(sun_elev)*np.sin(sun_az)])
    sun_color=srgb([255,238,214])*3.5
    upper=dirs[:,1]>0
    clipped_mask=np.any(raw>8,axis=1)
    ang=np.degrees(np.arccos(np.clip(dirs@sun,-1,1)))
    removed_luma=loss@LUMA
    total_removed=float(removed_luma@omega)
    quantile=[]
    order=np.argsort(ang); cum=np.cumsum((removed_luma*omega)[order]); cum/=cum[-1]
    for q in [.5,.9,.95,.99,.999]:
        quantile.append({'fraction_removed_energy':q,'cone_radius_deg':float(ang[order[np.searchsorted(cum,q)]])})
    angular=[]
    for radius in [.27,.5,1,2,5,10,20,40,90]:
        inside=ang<=radius
        angular.append({'radius_deg':radius,'removed_energy_inside_fraction':float((removed_luma*omega)[inside].sum()/total_removed),
                        'clipped_solid_angle_inside_sr':float(omega[inside&clipped_mask].sum())})
    summary={
      'status':'CPU_SKY_ONLY_REFERENCE_NOT_GPU_TARGET','source':str(SRC),'sha256':hashlib.sha256(SRC.read_bytes()).hexdigest(),
      'header':header,'dimensions':[w,h], 'radiance_units':'Uncalibrated linear HDR RGB; never interpreted as cd/m2 or lux',
      'decode':'r180 RGBE/255, float16 texture storage. No bilinear sample/cubemap resample simulated.',
      'solid_angle_sum_sr':float(omega.sum()), 'max_source_rgb':rgb.max(axis=(0,1)).tolist(),
      'half_float_limit_pixels':int(np.any(rgb>65504,axis=2).sum()),
      'runtime_half_rgba_sha256':hashlib.sha256(np.concatenate([half_bits,np.full((h,w,1),0x3c00,dtype=np.uint16)],axis=2).astype('<u2').tobytes()).hexdigest(),
      'half_float_mean_abs_relative_luma_error':float(np.mean(np.abs((half@LUMA)-(rgb@LUMA)))/np.mean(rgb@LUMA)),
      'half_float_full_sphere_energy_loss_fraction':float(1-((half@LUMA).ravel()@omega)/((rgb@LUMA).ravel()@omega)),
      'maximum_luma_texel':[sx,sy], 'maximum_texel_rgb':raw[maxindex].tolist(),
      'solar_source_texel':[1218.5,239.5], 'solar_direction':sun.tolist(),
      'solar_elevation_deg':float(np.degrees(sun_elev)), 'solar_azimuth_deg':float(np.degrees(sun_az)),
      'linear_direct_sun_rgb':sun_color.tolist(),'linear_direct_sun_luma':float(sun_color@LUMA),
      'clip_affected_pixels_fraction':float(clipped_mask.mean()),
      'clip_affected_full_sphere_solid_angle_fraction':float(omega[clipped_mask].sum()/(4*np.pi)),
      'clip_affected_upper_hemisphere_solid_angle_fraction':float(omega[clipped_mask&upper].sum()/(2*np.pi)),
      'clip_affected_max_distance_from_sun_deg':float(ang[clipped_mask].max()),
      'full_sphere_integrated_radiance':integrate_pair(raw,clipped,omega),
      'upper_hemisphere_integrated_radiance':integrate_pair(raw,clipped,omega*upper),
      'lower_hemisphere_integrated_radiance':integrate_pair(raw,clipped,omega*(~upper)),
      'removed_energy_angle_quantiles':quantile,'removed_energy_solar_cones':angular,
      'diffuse_irradiance':[], 'rough_specular_reference':[]}
    normals={'up':[0,1,0],'positive_x':[1,0,0],'negative_x':[-1,0,0],'positive_z':[0,0,1],'negative_z':[0,0,-1],
             'facing_sun':sun.tolist(),'tilt20_toward_sun':[math.sin(math.radians(20))*math.cos(sun_az),math.cos(math.radians(20)),math.sin(math.radians(20))*math.sin(sun_az)],
             'tilt20_away_sun':[-math.sin(math.radians(20))*math.cos(sun_az),math.cos(math.radians(20)),-math.sin(math.radians(20))*math.sin(sun_az)]}
    for name,n in normals.items():
        n=np.array(n); row=integrate_pair(raw,clipped,omega*np.maximum(dirs@n,0))
        direct=sun_color*max(float(sun@n),0); lost=np.array(row['raw_rgb'])-np.array(row['clipped_rgb'])
        row.update(name=name,normal=n.tolist(),direct_sun_rgb=direct.tolist(),
                   removed_irradiance_rgb=lost.tolist(),
                   old_raw_sky_scaled_luma=.8*row['raw_luma'],
                   clipped_sky_plus_direct_luma=.8*row['clipped_luma']+float(direct@LUMA),
                   direct_over_removed_scaled_luma=float(direct@LUMA/(.8*(lost@LUMA))) if lost@LUMA>0 else None)
        summary['diffuse_irradiance'].append(row)
    views=[('view_to_positive_x',.1,0),('view_to_negative_x',.1,np.pi),
           ('view_to_positive_z',.1,np.pi/2),('view_to_negative_z',.1,-np.pi/2),
           ('view_away_sun',.1,sun_az+np.pi),('view_toward_sun',.1,sun_az),
           ('mirror_sun',float(sun[1]),sun_az+np.pi),('overhead',1.,0)]
    for r in [.3,.6,.837,1.]:
        for name,nv,a in views:
            v=np.array([math.sqrt(1-nv*nv)*math.cos(a),nv,math.sqrt(1-nv*nv)*math.sin(a)])
            weight=response(dirs,v,r)*omega
            row=integrate_pair(raw,clipped,weight)
            direct=sun_color*response(sun[None,:],v,r)[0]
            row.update(view_name=name,NdotV=nv,view_direction=v.tolist(),roughness=r,
                       direct_sun_luma=float(direct@LUMA),
                       raw_sky_scaled_luma=.8*row['raw_luma'],
                       clipped_sky_plus_direct_luma=.8*row['clipped_luma']+float(direct@LUMA),
                       replacement_over_raw_sky=(.8*row['clipped_luma']+float(direct@LUMA))/(.8*row['raw_luma']))
            summary['rough_specular_reference'].append(row)
    (OUT/'hdr-analysis.json').write_text(json.dumps(summary,indent=2),encoding='utf8')
    # A bin table keeps this analysis inspectable without loading the giant HDR.
    bins=[0,.27,.5,1,2,5,10,20,40,90,180]
    with (OUT/'clipping-angular-bins.csv').open('w',encoding='utf8') as f:
        f.write('angle_min_deg,angle_max_deg,removed_luma_integral,removed_fraction,clipped_solid_angle_sr\n')
        for lo,hi in zip(bins[:-1],bins[1:]):
            m=(ang>=lo)&(ang<hi)
            q=float((removed_luma*omega)[m].sum())
            f.write(f'{lo},{hi},{q},{q/total_removed},{omega[m&clipped_mask].sum()}\n')
    print(json.dumps({k:summary[k] for k in ['sha256','dimensions','maximum_luma_texel','max_source_rgb','solar_direction','solar_elevation_deg','solar_azimuth_deg','clip_affected_upper_hemisphere_solid_angle_fraction','clip_affected_max_distance_from_sun_deg','upper_hemisphere_integrated_radiance','removed_energy_angle_quantiles']},indent=2))
    for x in summary['diffuse_irradiance']: print('DIFFUSE',x['name'],x['raw_luma'],x['clipped_luma'],x['direct_over_removed_scaled_luma'])
    for x in summary['rough_specular_reference']:
        if x['roughness']==.837: print('GGX',x['view_name'],x['raw_sky_scaled_luma'],x['clipped_sky_plus_direct_luma'],x['replacement_over_raw_sky'])

if __name__=='__main__': main()
