"""Inspect an acquired native Blender kit, without executing embedded scripts.
Preserves vendor sources. Saves an editable inspection copy and a geometry/material report.
"""
import bpy,json,sys,math
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'sources'/'native-models'/'modular_factory_facade'
files=sorted(SOURCE.rglob('*.blend'))
if len(files)!=1:raise RuntimeError(f'Expected one native source blend, found {len(files)}')
bpy.ops.wm.open_mainfile(filepath=str(files[0]),load_ui=False,use_scripts=False)
scene=bpy.context.scene
scene.render.threads_mode='FIXED';scene.render.threads=3
remaps=[];missing=[];lighting_omissions=[]
for im in list(bpy.data.images):
    if im.source!='FILE':continue
    absolute=Path(bpy.path.abspath(im.filepath,library=im.library))
    if im.packed_file or absolute.exists():continue
    if absolute.name=='abandoned_pathway_1k.hdr':
        replacement=ROOT/'sources'/'pbr'/'local-originals'/'sky'/'kloofendal_48d_partly_cloudy_puresky_2k.hdr'
        if not replacement.exists():raise RuntimeError('Known inspection sky source missing')
        old=im.filepath;im.filepath=str(replacement);im.reload()
        lighting_omissions.append({'image':im.name,'path':old,'replacement':str(replacement.relative_to(ROOT)),'reason':'Author preview HDRI is not in the distributed package; replaced for inspection, model PBR maps are unchanged.'})
        continue
    matches=list(SOURCE.rglob(absolute.name))
    if len(matches)==1:
        old=im.filepath;im.filepath=str(matches[0]);im.reload()
        remaps.append({'image':im.name,'original':old,'resolved':str(matches[0].relative_to(ROOT))})
    else:
        world_only=any(w.use_nodes and any(n.bl_idname=='ShaderNodeTexEnvironment' and n.image==im for n in w.node_tree.nodes) for w in bpy.data.worlds)
        material_use=any(m.use_nodes and any(n.bl_idname=='ShaderNodeTexImage' and n.image==im for n in m.node_tree.nodes) for m in bpy.data.materials)
        if world_only and not material_use:
            lighting_omissions.append({'image':im.name,'path':str(absolute),'reason':'Vendor preview HDRI is not distributed with the model; neutral inspection lighting replaces it.'})
            bpy.data.images.remove(im,do_unlink=True)
        else:missing.append({'image':im.name,'path':str(absolute)})
if missing:raise RuntimeError('Missing original image dependencies: '+json.dumps(missing))
deps=bpy.context.evaluated_depsgraph_get()
records=[]
for ob in scene.objects:
    if ob.type!='MESH':continue
    pts=[ob.matrix_world@Vector(p) for p in ob.bound_box]
    lo=[min(p[a] for p in pts) for a in range(3)];hi=[max(p[a] for p in pts) for a in range(3)]
    ev=ob.evaluated_get(deps);me=ev.to_mesh();me.calc_loop_triangles()
    records.append({'name':ob.name,'location':list(ob.location),'rotation':list(ob.rotation_euler),'scale':list(ob.scale),'bounds':[lo,hi],'dimensions':[hi[a]-lo[a] for a in range(3)],'triangles':len(me.loop_triangles),'collections':[c.name for c in ob.users_collection],'materials':[m.name if m else None for m in ob.data.materials],'uv_layers':[u.name for u in me.uv_layers]})
    ev.to_mesh_clear()
materials=[]
for mat in bpy.data.materials:
    if not mat.use_nodes:continue
    materials.append({'name':mat.name,'nodes':[{'type':n.bl_idname,'name':n.name,'image':n.image.name if n.bl_idname=='ShaderNodeTexImage' and n.image else None} for n in mat.node_tree.nodes],'images':[{'name':n.image.name,'path':n.image.filepath,'size':list(n.image.size),'color_space':n.image.colorspace_settings.name} for n in mat.node_tree.nodes if n.bl_idname=='ShaderNodeTexImage' and n.image]})
report={'source':str(files[0].relative_to(ROOT)),'scene':scene.name,'unit_scale':scene.unit_settings.scale_length,'scene_object_count':len(scene.objects),'objects':records,'materials':materials,'all_images':[{'name':im.name,'path':im.filepath,'size':list(im.size),'color_space':im.colorspace_settings.name,'packed':bool(im.packed_file)} for im in bpy.data.images if im.source=='FILE'],'image_remaps':remaps,'missing_images':missing,'omitted_vendor_preview_lighting':lighting_omissions,'status':'Inventory only; material appearance and building suitability require rendered review'}
(ROOT/'review'/'native-factory-inventory.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'review'/'native_factory_inspection.blend'))
print('FACTORY_NATIVE_INVENTORY_COMPLETE',len(records),len(materials),flush=True)
for r in records:print(json.dumps({k:r[k] for k in ['name','dimensions','bounds','materials','triangles']},ensure_ascii=False))
