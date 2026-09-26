"""Export eight editable logical groups, retaining UVs and actual displaced geometry."""
import bpy,json,struct
from pathlib import Path
R=Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(R/'scene/longwan_roadside_editable.blend'),load_ui=False,use_scripts=False)
S=bpy.context.scene;deps=bpy.context.evaluated_depsgraph_get();root=bpy.data.objects['Roadside_24m']
C=bpy.data.collections.new('Runtime export copies');S.collection.children.link(C)
outs=[];records=[]
for group in root.children:
    parts=[]
    for ob in group.children_recursive:
        if ob.get('export_helper'):continue
        if ob.type not in {'MESH','CURVE','FONT'}:continue
        ev=ob.evaluated_get(deps);me=bpy.data.meshes.new_from_object(ev,preserve_all_data_layers=True,depsgraph=deps)
        o=bpy.data.objects.new(ob.name+'_runtime',me);C.objects.link(o);o.matrix_world=ob.matrix_world.copy();parts.append(o)
    if not parts:continue
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts:o.select_set(True)
    bpy.context.view_layer.objects.active=parts[0];bpy.ops.object.join();o=bpy.context.object;o.name=group.name;o.data.calc_loop_triangles();outs.append(o)
    records.append({'name':group.name,'source_parts':len(parts),'triangles':len(o.data.loop_triangles),'materials':len(o.material_slots),'dimensions_m':list(o.dimensions)})
bpy.ops.object.select_all(action='DESELECT')
for o in outs:o.select_set(True)
bpy.context.view_layer.objects.active=outs[0]
path=R/'models/longwan_roadside_native.glb'
bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_apply=True,export_yup=True,export_extras=True,export_cameras=False,export_lights=False,export_image_format='AUTO')
# Alpha blending preserves thin wire coverage when mipmaps become smaller.
# A fixed MASK cutoff visibly discarded distant wire during browser review.
raw=path.read_bytes();size,kind=struct.unpack_from('<II',raw,12);d=json.loads(raw[20:20+size]);changed=[]
for material in d['materials']:
    if material['name'].startswith('modular_chainlink_fence_wire'):
        material['alphaMode']='BLEND';material.pop('alphaCutoff',None);changed.append(material['name'])
encoded=json.dumps(d,ensure_ascii=False,separators=(',',':')).encode();encoded+=b' '*(-len(encoded)%4)
tail=raw[20+size:];path.write_bytes(struct.pack('<III',0x46546c67,2,20+len(encoded)+len(tail))+struct.pack('<II',len(encoded),kind)+encoded+tail)
report={'source_blend':'scene/longwan_roadside_editable.blend','file':str(path.relative_to(R)),'groups':records,'triangles':sum(r['triangles'] for r in records),'bytes':path.stat().st_size,'cutout_materials':changed,'visual_status':'Pending runtime browser inspection','not_run':['Game integration','Collision','Target game performance']}
(R/'review/roadside-export.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print('ROADSIDE_EXPORT_COMPLETE',json.dumps({k:v for k,v in report.items() if k!='groups'}),flush=True)
