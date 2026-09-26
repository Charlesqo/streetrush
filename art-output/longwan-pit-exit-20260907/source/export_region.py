"""Export each logical asset root as a portable mesh group; preserve editable source."""
import bpy,json
from pathlib import Path
R=Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(R/'scene/longwan_region_editable.blend'),load_ui=False,use_scripts=False)
S=bpy.context.scene;REGION=bpy.data.objects['Longwan_96m_Region'];deps=bpy.context.evaluated_depsgraph_get();C=bpy.data.collections.new('Region export copies');S.collection.children.link(C)
outs=[];records=[]
for root in list(REGION.children):
    if root.name=='Region_presentation':continue
    parts=[]
    for src in root.children_recursive:
        if src.type not in {'MESH','CURVE','FONT'} or src.get('export_helper'):continue
        ev=src.evaluated_get(deps);me=bpy.data.meshes.new_from_object(ev,preserve_all_data_layers=True,depsgraph=deps)
        if not len(me.vertices):bpy.data.meshes.remove(me);continue
        # A join keeps distinct UV layer names, filling missing layers with zeroes.
        # Preserve each object's actual active UVs under one canonical layer first.
        active=me.uv_layers.active
        if active:
            for layer in list(me.uv_layers):
                if layer!=active:me.uv_layers.remove(layer)
            active.name='UVMap';me.uv_layers.active_index=0
        if 'RegionTint' not in me.color_attributes:
            a=me.color_attributes.new(name='RegionTint',type='FLOAT_COLOR',domain='CORNER');a.data.foreach_set('color',[1.0]*(len(a.data)*4))
        ob=bpy.data.objects.new(src.name+'_export',me);C.objects.link(ob);ob.matrix_world=src.matrix_world.copy();parts.append(ob)
    if not parts:continue
    bpy.ops.object.select_all(action='DESELECT')
    for ob in parts:ob.select_set(True)
    bpy.context.view_layer.objects.active=parts[0];bpy.ops.object.join();ob=bpy.context.object;ob.name=root.name;ob.data.calc_loop_triangles();outs.append(ob)
    records.append({'name':root.name,'source_parts':len(parts),'triangles':len(ob.data.loop_triangles),'material_slots':len(ob.material_slots),'uv_layers':[uv.name for uv in ob.data.uv_layers],'color_attributes':[a.name for a in ob.data.color_attributes]})
bpy.ops.object.select_all(action='DESELECT')
for ob in outs:ob.select_set(True)
bpy.context.view_layer.objects.active=outs[0];path=R/'models/longwan_region_native.glb'
bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_apply=True,export_yup=True,export_extras=True,export_cameras=False,export_lights=False,export_image_format='AUTO')
report={'source':'scene/longwan_region_editable.blend','file':str(path.relative_to(R)),'groups':records,'triangles':sum(row['triangles'] for row in records),'bytes':path.stat().st_size,'scope':'Current finite 96m asset region, independent from the game','game_integration':'NOT_RUN','visual_status':'Pending actual browser inspection'}
(R/'review/region-export.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print('REGION_EXPORT_COMPLETE',json.dumps({k:v for k,v in report.items() if k!='groups'}),flush=True)
