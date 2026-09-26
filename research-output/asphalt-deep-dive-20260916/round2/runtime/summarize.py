import json
from pathlib import Path

root=Path(__file__).resolve().parent
matrix=json.loads((root/'full-scene-matrix-gpu.json').read_text(encoding='utf-8'))
dfg=json.loads((root/'full-scene-dfg-gpu.json').read_text(encoding='utf-8'))
probe=json.loads((root/'full-scene-probe-post-gpu.json').read_text(encoding='utf-8'))
out={'regions_m':[[3,8],[8,20],[20,50]],'source':'full static visual circuit fixture; not vehicle/physics/gameplay verification','matrix':[],'dfg':[]}
for row in matrix['rows']:
    if row['sampling']!='mixed':continue
    plain=next(r for r in matrix['rows'] if (r['view'],r['asset'],r['sampling'])==(row['view'],row['asset'],'plain'))
    regions=[]
    for i in range(3):
        a=row['aov'];total=a['total'][i]['mean']
        regions.append({'pixels':a['total'][i]['pixels'],'linear_total_mean':total,
          'direct_specular_pct':100*a['directSpecular'][i]['mean']/total,
          'environment_specular_pct':100*a['indirectSpecular'][i]['mean']/total,
          'mixed_highpass_drop_pct':100*(1-a['total'][i]['highpassRms']/plain['aov']['total'][i]['highpassRms']),
          'roughness_mean':a['roughness'][i]['mean'],'NdotV_mean':a['NdotV'][i]['mean']})
    out['matrix'].append({'view':row['view'],'asset':row['asset'],'regions':regions})
out['closure_max']=max(max(r['closureRelativeError']) for r in matrix['rows'])
base=next(r for r in matrix['rows'] if (r['view'],r['asset'],r['sampling'])==('middle','fine','mixed'))
out['shadows_middle_center_total_change_pct']=[100*(a['mean']/b['mean']-1) for a,b in zip(base['aov']['total'],matrix['noShadow']['aov']['total'])]
for row in dfg['dfg']['rows']:
    if row['variant']!='boundedReference':continue
    old=next(r for r in dfg['dfg']['rows'] if (r['view'],r['asset'],r['variant'])==(row['view'],row['asset'],'legacy'))
    regions=[]
    for i in range(3):
        ratios={k:row['aov'][k][i]['mean']/old['aov'][k][i]['mean'] for k in old['aov']}
        regions.append({'reference_domain_fraction':row['referenceDomainFraction'][i],
                        'linear_mean_ratios':ratios,
                        'total_highpass_ratio':row['aov']['total'][i]['highpassRms']/old['aov']['total'][i]['highpassRms'],
                        'total_std_mean_ratio_change':(row['aov']['total'][i]['std']/row['aov']['total'][i]['mean'])/(old['aov']['total'][i]['std']/old['aov']['total'][i]['mean'])})
    out['dfg'].append({'view':row['view'],'asset':row['asset'],'regions':regions})
for key in ['probeHistory','probeFrozenLOD']:
    data=probe[key]['history'];first,last=data[0],data[-1]
    out[key]={'total_change_pct':[100*(b['mean']/a['mean']-1) for a,b in zip(first['aov']['total'],last['aov']['total'])],
      'env_spec_change_pct':[100*(b['mean']/a['mean']-1) for a,b in zip(first['aov']['indirectSpecular'],last['aov']['indirectSpecular'])]}
out['probeHistory']['starting_capture_count']=probe['probeHistory']['startingCaptureCount']
out['probeHistory']['mask_hashes_invariant']=len({tuple(r['maskHashes']) for r in probe['probeHistory']['history']})==1
out['probeFrozenLOD']['levels_invariant']=len({tuple(r['levels']) for r in probe['probeFrozenLOD']['history']})==1
out['postprocess']=probe['postprocess']
(root/'summary.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(out,ensure_ascii=False,indent=2))
