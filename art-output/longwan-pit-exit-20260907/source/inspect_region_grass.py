import bpy,json
from pathlib import Path
from mathutils import Vector
R=Path(__file__).resolve().parents[1];path=R/'sources/native-models/grass_medium_01/grass_medium_01_1k.blend'
bpy.ops.wm.open_mainfile(filepath=str(path),load_ui=False,use_scripts=False)
S=bpy.context.scene
rows=[]
for o in bpy.data.objects:
    rows.append({'name':o.name,'type':o.type,'vertices':len(o.data.vertices) if o.type=='MESH' else None,'polygons':len(o.data.polygons) if o.type=='MESH' else None,'location':list(o.location),'dimensions':list(o.dimensions),'modifiers':[m.type for m in o.modifiers],'materials':[m.name if m else None for m in o.data.materials] if o.type=='MESH' else []})
(R/'review/grass-native-inventory.json').write_text(json.dumps({'objects':rows,'collections':[c.name for c in bpy.data.collections]},indent=2))
print('GRASS_INVENTORY_COMPLETE',flush=True)
