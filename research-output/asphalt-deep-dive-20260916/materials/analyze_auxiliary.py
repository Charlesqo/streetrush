"""Read unused source Specular/Gloss maps; do not infer an export workflow."""
import io,json,zipfile
import numpy as np
from PIL import Image
from analyze_materials import OUT,DOWNLOADS,ASSETS,stats,srgb_to_linear,corr

report={}
for key,fn in [('asphalt','fine_asphalt_vlzobiady_4k.zip'),('fresh','asphalt_fresh_sfrofg0a_4k.zip')]:
    with zipfile.ZipFile(DOWNLOADS/fn) as z:
        spec=np.asarray(Image.open(io.BytesIO(z.read(next(n for n in z.namelist() if n.endswith('_Specular.jpg'))))).convert('L'),dtype=np.float32)/255
        gloss=np.asarray(Image.open(io.BytesIO(z.read(next(n for n in z.namelist() if n.endswith('_Gloss.jpg'))))).convert('L'),dtype=np.float32)/255
    rough=np.asarray(Image.open(ASSETS/key/'Roughness.jpg').convert('L'),dtype=np.float32)/255
    report[key]={'specular_file_encoded':stats(spec),
        'specular_srgb_decoded':stats(srgb_to_linear(spec)),
        'gloss_vs_one_minus_roughness_mean_absolute_difference':float(np.mean(np.abs(gloss-(1-rough)))),
        'specular_roughness_correlation':corr(spec[::4,::4],rough[::4,::4]),
        'caveat':'Metadata calls specular sRGB; these stats do not prove the map is a measured Fresnel F0, or that current metal/rough workflow must use it.'}
(OUT/'auxiliary-map-checks.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2))
