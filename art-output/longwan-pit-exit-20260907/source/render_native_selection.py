"""Render selected acquired components with their original materials and a clay override.
Selection is explicit in review/native-selection.json, produced after inspecting the inventory.
"""
import bpy,json,math
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
config=json.loads((ROOT/'review'/'native-selection.json').read_text())
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'review'/'native_factory_inspection.blend'),load_ui=False,use_scripts=False)
scene=bpy.context.scene
selected=[]
for ob in scene.objects:
    if ob.type=='MESH':
        visible=ob.name in config['objects'];ob.hide_render=not visible
        if visible:selected.append(ob)
    elif ob.type=='LIGHT':ob.hide_render=True
if len(selected)!=len(config['objects']):raise RuntimeError('Selection missing from native scene')
points=[ob.matrix_world@Vector(p) for ob in selected for p in ob.bound_box]
lo=Vector([min(p[a] for p in points) for a in range(3)]);hi=Vector([max(p[a] for p in points) for a in range(3)])
centre=(lo+hi)/2;size=hi-lo;extent=max(size.x,size.y,size.z)
collection=bpy.data.collections.new('Inspection lighting');scene.collection.children.link(collection)
world=bpy.data.worlds.new('Neutral inspection environment');scene.world=world;world.use_nodes=True
background=next(n for n in world.node_tree.nodes if n.bl_idname=='ShaderNodeBackground')
background.inputs['Color'].default_value=(.42,.47,.52,1)
background.inputs['Strength'].default_value=.40
def light(name,power,position,area_size):
    data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=area_size
    ob=bpy.data.objects.new(name,data);collection.objects.link(ob);ob.location=position;ob.rotation_euler=(centre-ob.location).to_track_quat('-Z','Y').to_euler()
light('Large daylight key',1900*extent/5,centre+Vector((-extent*.65,-extent*.72,extent)),extent*.65)
light('Soft fill',650*extent/5,centre+Vector((extent*.7,-extent*.30,extent*.4)),extent*.8)
plane_mat=bpy.data.materials.new('Inspection base');plane_mat.use_nodes=True
bs=next(n for n in plane_mat.node_tree.nodes if n.bl_idname=='ShaderNodeBsdfPrincipled');bs.inputs['Base Color'].default_value=(.23,.25,.255,1);bs.inputs['Roughness'].default_value=.8
bpy.ops.mesh.primitive_plane_add(size=extent*200,location=(centre.x,centre.y,lo.z-.006));plane=bpy.context.object;plane.name='Inspection ground';plane.data.materials.append(plane_mat)
camera=bpy.data.cameras.new('Native material inspection');ob=bpy.data.objects.new('Native material inspection',camera);collection.objects.link(ob)
ob.location=centre+Vector(config.get('camera_offset',[-extent*.60,-extent*1.55,extent*.45]));ob.rotation_euler=(centre-ob.location).to_track_quat('-Z','Y').to_euler();camera.type='ORTHO';camera.ortho_scale=extent*1.28;scene.camera=ob
scene.render.engine='CYCLES';scene.cycles.samples=32;scene.cycles.use_denoising=True;scene.cycles.max_bounces=8;scene.cycles.transmission_bounces=6
scene.render.threads_mode='FIXED';scene.render.threads=3
scene.render.resolution_x=1600;scene.render.resolution_y=1100;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False
scene.view_settings.view_transform='AgX';scene.view_settings.look='AgX - Medium High Contrast';scene.view_settings.exposure=.3
scene.render.filepath=str(ROOT/'review'/'native-factory-material.png');bpy.ops.render.render(write_still=True)
clay=bpy.data.materials.new('Inspection clay');clay.use_nodes=True
bs=next(n for n in clay.node_tree.nodes if n.bl_idname=='ShaderNodeBsdfPrincipled');bs.inputs['Base Color'].default_value=(.42,.45,.46,1);bs.inputs['Roughness'].default_value=.7
for layer in scene.view_layers:layer.material_override=clay
scene.render.filepath=str(ROOT/'review'/'native-factory-clay.png');bpy.ops.render.render(write_still=True)
for layer in scene.view_layers:layer.material_override=None
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'review'/'native_factory_material_review.blend'))
print('NATIVE_MATERIAL_AND_GEOMETRY_REVIEW_RENDERED')
