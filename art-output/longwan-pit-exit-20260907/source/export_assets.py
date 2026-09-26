"""Export evaluated PBR assets from the editable scene; source .blend is never overwritten.
Merge by asset + material to reduce draw calls. Materials remain editable in the source.
"""
import bpy, json, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'scene'/'longwan_pit_exit_editable.blend'))
scene=bpy.context.scene
report={'source':str(ROOT/'scene'/'longwan_pit_exit_editable.blend'),'assets':[]}
deps=bpy.context.evaluated_depsgraph_get()
export_collection=bpy.data.collections.new('GLB optimized geometry');scene.collection.children.link(export_collection)
roots=[o for o in scene.objects if o.type=='EMPTY' and o.name!='Presentation' and 'asset_description' in o]
exports=[]
for root in roots:
    pieces=[]
    for ob in list(root.children_recursive):
        if ob.type not in {'MESH','CURVE','FONT'}:continue
        ev=ob.evaluated_get(deps)
        me=bpy.data.meshes.new_from_object(ev,preserve_all_data_layers=True,depsgraph=deps)
        copy=bpy.data.objects.new(ob.name+'_export',me);export_collection.objects.link(copy)
        copy.matrix_world=ob.matrix_world.copy()
        pieces.append(copy)
    if not pieces:continue
    bpy.ops.object.select_all(action='DESELECT')
    for ob in pieces:ob.select_set(True)
    bpy.context.view_layer.objects.active=pieces[0]
    bpy.ops.object.join()
    out=bpy.context.view_layer.objects.active;out.name=root.name
    out['description']=root['asset_description']
    # Individual asset local origin is the source asset pivot.
    old_matrix=out.matrix_world.copy()
    bpy.context.scene.cursor.location=root.matrix_world.translation
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    out.location-=root.location
    path=ROOT/'models'/f'{root.name}.glb'
    bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_apply=True,export_yup=True,export_extras=True,export_cameras=False,export_lights=False,export_image_format='AUTO')
    out.location+=root.location
    out.data.calc_loop_triangles()
    report['assets'].append({'name':root.name,'file':str(path.relative_to(ROOT)),'triangles':len(out.data.loop_triangles),'material_slots':len(out.material_slots),'file_bytes':path.stat().st_size,'scene_location_metres':list(root.location),'description':root['asset_description']})
    exports.append(out)
bpy.ops.object.select_all(action='DESELECT')
for ob in exports:ob.select_set(True)
bpy.context.view_layer.objects.active=exports[0]
scene_path=ROOT/'scene'/'longwan_pit_exit.glb'
bpy.ops.export_scene.gltf(filepath=str(scene_path),export_format='GLB',use_selection=True,export_apply=True,export_yup=True,export_extras=True,export_cameras=False,export_lights=False,export_image_format='AUTO')
report['scene_file']='scene/longwan_pit_exit.glb';report['scene_bytes']=scene_path.stat().st_size
report['total_triangles']=sum(a['triangles'] for a in report['assets'])
report['note']='Evaluated art geometry; individual local pivots, metre units, +Y up in glTF. Game integration/collision/target performance NOT_RUN.'
(ROOT/'review'/'export-report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf8')
print('LONGWAN_EXPORT_COMPLETE')
