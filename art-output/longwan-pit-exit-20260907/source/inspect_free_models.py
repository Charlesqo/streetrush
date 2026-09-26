"""One finite inspection batch of acquired third-party originals, never modifying them."""
import bpy,json,math
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
report=[]
for ident in ['concrete_road_barrier','modular_chainlink_fence','modular_electric_cables']:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path=ROOT/'sources'/'free-models'/ident/f'{ident}_2k.gltf'
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects=[o for o in bpy.context.scene.objects if o.type=='MESH']
    records=[];pts=[]
    for ob in objects:
        p=[ob.matrix_world@Vector(c) for c in ob.bound_box];pts+=p
        records.append({'name':ob.name,'dimensions_m':list(ob.dimensions),'location':list(ob.location),'bounds_min':[min(v[i] for v in p) for i in range(3)],'bounds_max':[max(v[i] for v in p) for i in range(3)]})
    lo=Vector([min(v[i] for v in pts) for i in range(3)]);hi=Vector([max(v[i] for v in pts) for i in range(3)]);center=(lo+hi)/2;size=(hi-lo).length
    report.append({'asset':ident,'source':str(path.relative_to(ROOT)),'objects':records})
    # Actual source material inspected under a simple daylight studio.
    s=bpy.context.scene;s.world=bpy.data.worlds.new('Neutral studio');s.world.use_nodes=True
    bg=next(n for n in s.world.node_tree.nodes if n.bl_idname=='ShaderNodeBackground');bg.inputs['Color'].default_value=(.50,.56,.61,1);bg.inputs['Strength'].default_value=.7
    bpy.ops.mesh.primitive_plane_add(size=size*3,location=(center.x,center.y,lo.z-.015));plane=bpy.context.object
    m=bpy.data.materials.new('Inspection ground');m.diffuse_color=(.25,.27,.27,1);plane.data.materials.append(m)
    sun=bpy.data.lights.new('Daylight','SUN');sun.energy=2.1;sun.angle=.06
    ob=bpy.data.objects.new('Daylight',sun);s.collection.objects.link(ob);ob.rotation_euler=Vector((.5,.7,-1)).to_track_quat('-Z','Y').to_euler()
    ca=bpy.data.cameras.new('Inspect');ca.lens=50
    ob=bpy.data.objects.new('Inspect',ca);s.collection.objects.link(ob);ob.location=center+Vector((-.75,-1.0,.70))*size*.95;ob.rotation_euler=(center-ob.location).to_track_quat('-Z','Y').to_euler();s.camera=ob
    s.render.engine='CYCLES';s.cycles.samples=20;s.cycles.use_denoising=True;s.render.threads_mode='FIXED';s.render.threads=3
    s.render.resolution_x=1200;s.render.resolution_y=800;s.render.resolution_percentage=100;s.render.image_settings.file_format='PNG';s.view_settings.view_transform='AgX'
    s.render.filepath=str(ROOT/'review'/f'acquired-{ident}.png');bpy.ops.render.render(write_still=True)
    print('ACQUIRED_INSPECTION_COMPLETE',ident,flush=True)
(ROOT/'review'/'free-model-geometry.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
