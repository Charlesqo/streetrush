"""Extract reusable construction units from the actual reviewed scene.
Never overwrites the combined editable source scene. All coordinates are metres.
"""
import bpy,json
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'scene'/'longwan_pit_exit_editable.blend'))
original=bpy.context.scene;deps=bpy.context.evaluated_depsgraph_get()
library=bpy.data.scenes.new('Longwan construction module library')
library.unit_settings.system='METRIC';library.unit_settings.scale_length=1
outdir=ROOT/'models'/'modules';outdir.mkdir(exist_ok=True)
reports=[]

def bounds(ob):
    pts=[ob.matrix_world@Vector(p) for p in ob.bound_box]
    return (Vector([min(p[a] for p in pts) for a in range(3)]),Vector([max(p[a] for p in pts) for a in range(3)]))

def snapshot(ob,collection,pivot=(0,0,0),shift=0,clip_rail=False):
    ev=ob.evaluated_get(deps)
    me=bpy.data.meshes.new_from_object(ev,preserve_all_data_layers=True,depsgraph=deps)
    me.transform(ob.matrix_world)
    if clip_rail:
        # Existing W profile is an X extrusion: move its two ends, retain the formed section.
        for v in me.vertices:v.co.x=0 if v.co.x<0 else 4
        me.update()
        for poly in me.polygons:
            if abs(poly.normal.x)>.9:continue
            tile=me.materials[poly.material_index].get('tile_metres',.4)
            for li in poly.loop_indices:
                vi=me.loops[li].vertex_index;me.uv_layers.active.data[li].uv.x=me.vertices[vi].co.x/tile
    for v in me.vertices:v.co-=Vector(pivot);v.co.x+=shift
    copy=bpy.data.objects.new(ob.name,me);collection.objects.link(copy)
    return copy

def export_module(name,description,specs,pivot):
    collection=bpy.data.collections.new(name);library.collection.children.link(collection)
    pieces=[]
    for ob,shift,clip in specs:pieces.append(snapshot(ob,collection,pivot,shift,clip))
    if not pieces:raise RuntimeError('Empty module: '+name)
    bpy.context.window.scene=library
    bpy.ops.object.select_all(action='DESELECT')
    for ob in pieces:ob.select_set(True)
    bpy.context.view_layer.objects.active=pieces[0];bpy.ops.object.join()
    out=bpy.context.object;out.name=name;out['description']=description
    out['source_revision']=original.get('revision','unknown')
    collection.asset_mark();collection.asset_data.description=description
    path=outdir/(name+'.glb')
    bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_apply=True,export_yup=True,export_extras=True,export_cameras=False,export_lights=False)
    out.data.calc_loop_triangles();lo,hi=bounds(out)
    reports.append({'name':name,'file':str(path.relative_to(ROOT)),'description':description,'triangles':len(out.data.loop_triangles),'dimensions_m':list(hi-lo),'bounds_m':[list(lo),list(hi)],'bytes':path.stat().st_size})
    # Display the library units beside one another; collection drag/drop retains the local pivot.
    out.location.x=(len(reports)-1)*6
    collection.instance_offset=out.location.copy()
    bpy.context.window.scene=original

track=bpy.data.objects['G01_Track_and_Runoff']
selected=[]
for ob in track.children_recursive:
    if not ob.name.startswith(('Sloped modular concrete kerb core','Worn kerb surface coating')):continue
    lo,hi=bounds(ob)
    if lo.x>=-.015 and hi.x<=2.415:selected.append((ob,0,False))
export_module('M01_Kerb_Red_White_2p4m','2.4m two-colour kerb pair. Editable concrete core and chipped paint. Pivot at leading road edge, road elevation Z=0.',selected,(0,-7.06,0))

drain=bpy.data.objects['G02_Drainage_Channel'];selected=[]
for ob in drain.children_recursive:
    if ob.type!='MESH':continue
    lo,hi=bounds(ob)
    if lo.x>=-31.015 and hi.x<=-29.985:selected.append((ob,0,False))
export_module('M02_Trench_Drain_1m','1m drainage channel. Pivot on finished grate level; body extends below grade.',selected,(-30.5,14.13,.08))

boundary=bpy.data.objects['B02_Armco_and_Catch_Fence'];selected=[]
prefixes=('Catch fence cranked stanchion','Post baseplate','Independent catch fence footing','Fence base anchor','Mesh fixing clamp','Welded safety wire grid','Fence tension cable')
for ob in boundary.children_recursive:
    if ob.type!='MESH' or not ob.name.startswith(prefixes):continue
    lo,hi=bounds(ob)
    if lo.x>=-.25 and hi.x<=4.25:selected.append((ob,0,False))
export_module('M03_Catch_Fence_4m','4m catch-fence panel with two complete stanchions, independent footings, anchor bolts, clamps and tension cables.',selected,(0,-14.22,0))

selected=[]
for ob in boundary.children_recursive:
    if ob.type!='MESH':continue
    if ob.name.startswith('W beam pressed steel crash rail'):
        selected.append((ob,0,True));continue
    if not ob.name.startswith(('Galvanized post web','Post I flange','Hex anchor with washer')):continue
    lo,hi=bounds(ob);centre=(lo.x+hi.x)*.5
    for source,target in [(-.2,1),(2.3,3)]:
        if abs(centre-source)<.10:selected.append((ob,target-source,False));break
export_module('M04_Armco_Double_4m','4m formed double guardrail, two I-section posts at 2m centres, fixings. Pivot at beginning and road-facing rail centreline.',selected,(0,-14.5,0))

bpy.context.window.scene=library
for scene in list(bpy.data.scenes):
    if scene!=library:bpy.data.scenes.remove(scene)
for ob in list(bpy.data.objects):
    if not ob.users_scene:bpy.data.objects.remove(ob,do_unlink=True)
for group in [bpy.data.collections,bpy.data.meshes,bpy.data.curves,bpy.data.materials,bpy.data.images]:
    for block in list(group):
        if block.users==0:group.remove(block)
library['description']='Longwan reusable construction modules; independent art collection, not integrated into game.'
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(outdir/'longwan_module_library.blend'))
(ROOT/'review'/'module-export-report.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2),encoding='utf8')
print('LONGWAN_MODULES_EXPORTED',len(reports))
