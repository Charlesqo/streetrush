from pathlib import Path
import json

root=Path(__file__).resolve().parents[1]
runtime=root/'runtime'
matrix=json.loads((runtime/'material-matrix-gpu.json').read_text())
rows={(r['asset'],r['sampling'],r['view'],r['illumination']):r for r in matrix['rows']}
summary=[]
for key in ['asphalt','fresh']:
    a=rows[key,'plain','drive','all']['aov'];b=rows[key,'mixed','drive','all']['aov']
    for i,region in enumerate(['3-8 m','8-20 m','20-50 m']):
        summary.append({'asset':key,'region':region,'totalMeanPlain':a['total'][i]['mean'],'totalMeanMixed':b['total'][i]['mean'],'highpassRetainedPercent':100*b['total'][i]['highpassRms']/a['total'][i]['highpassRms'],'specularSharePercent':100*(a['directSpecular'][i]['mean']+a['indirectSpecular'][i]['mean'])/a['total'][i]['mean']})
(runtime/'summary.json').write_text(json.dumps({'rows':summary,'maxAovClosureRelativeError':max(r['closureRelativeError'] for r in matrix['rows'])},indent=2),encoding='utf-8')
print('Wrote summary.json')
