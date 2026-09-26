"""Bake evaluated Geometry Nodes examples to portable PBR glTF; preserve .blend."""
import bpy,json
from pathlib import Path
R=Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(R/'scene/longwan_kerb_procedural.blend'),load_ui=False,use_scripts=False)
S=bpy.context.scene;deps=bpy.context.evaluated_depsgraph_get()
C=bpy.data.collections.new('Portable mesh export copies');S.collection.children.link(C)
outs=[];records=[]
for name in ['01 Straight','02 Corner','03 S Curve']:
    source=bpy.data.objects[name]
    me=bpy.data.meshes.new_from_object(source.evaluated_get(deps),preserve_all_data_layers=True,depsgraph=deps)
    ob=bpy.data.objects.new(name+' | baked',me);C.objects.link(ob);ob.matrix_world=source.matrix_world.copy()
    me.calc_loop_triangles();assert me.uv_layers.active is not None
    used={face.material_index for face in me.polygons}
    assert all(index<len(me.materials) and me.materials[index] is not None for index in used),'A rendered face has no material'
    outs.append(ob);records.append({'name':name,'triangles':len(me.loop_triangles),'uv_layers':[u.name for u in me.uv_layers],'materials':[m.name if m else None for m in me.materials],'used_material_slots':sorted(used)})
bpy.ops.object.select_all(action='DESELECT')
for ob in outs:ob.select_set(True)
bpy.context.view_layer.objects.active=outs[0]
path=R/'models/longwan_kerb_examples_native.glb'
bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_yup=True,export_extras=True,export_cameras=False,export_lights=False,export_image_format='AUTO')
report={'source':'scene/longwan_kerb_procedural.blend','export':str(path.relative_to(R)),'objects':records,'bytes':path.stat().st_size,'editable_path_and_nodes':'Kept in source .blend only; GLB contains evaluated meshes','game_integration':'NOT_RUN'}
(R/'review/kerb-export.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print('KERB_EXAMPLES_EXPORT_COMPLETE',json.dumps(report),flush=True)
