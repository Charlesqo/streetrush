"""Export only the reconstructed building, without its presentation ground/lights."""
import bpy,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'scene'/'longwan_pit_building_native.blend'),load_ui=False,use_scripts=False)
scene=bpy.context.scene;deps=bpy.context.evaluated_depsgraph_get()
root=bpy.data.objects['Longwan_Pit_Building']
collection=bpy.data.collections.new('Exported building geometry');scene.collection.children.link(collection)
parts=[]
for ob in list(root.children_recursive):
    if ob.type not in {'MESH','FONT','CURVE'}:continue
    ev=ob.evaluated_get(deps);me=bpy.data.meshes.new_from_object(ev,preserve_all_data_layers=True,depsgraph=deps)
    copy=bpy.data.objects.new(ob.name+'_export',me);collection.objects.link(copy);copy.matrix_world=ob.matrix_world.copy();parts.append(copy)
bpy.ops.object.select_all(action='DESELECT')
for ob in parts:ob.select_set(True)
bpy.context.view_layer.objects.active=parts[0];bpy.ops.object.join()
out=bpy.context.object;out.name='Longwan_Pit_Building'
out['description']=root['asset_description'];out['source']='Poly Haven modular_factory_facade — James Ray Cock, CC0; adaptation, structural completion and circuit fittings authored for Longwan.'
path=ROOT/'models'/'longwan_pit_building_native.glb'
bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_apply=True,export_yup=True,export_extras=True,export_cameras=False,export_lights=False,export_image_format='AUTO')
out.data.calc_loop_triangles()
report={'source_blend':'scene/longwan_pit_building_native.blend','file':str(path.relative_to(ROOT)),'source_parts':len(parts),'triangles':len(out.data.loop_triangles),'material_slots':len(out.material_slots),'dimensions_m':list(out.dimensions),'bytes':path.stat().st_size,'status':'Exported; visual parity in realtime viewer still requires inspection','not_run':['Game integration','Collision','Target game performance']}
(ROOT/'review'/'native-building-export.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print('NATIVE_BUILDING_EXPORT_COMPLETE',json.dumps(report))
