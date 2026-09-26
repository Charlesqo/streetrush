"""Build, exercise and render the native editable kerb generator."""
import bpy,bmesh,json,math,hashlib
import numpy as np
from pathlib import Path
from mathutils import Vector
R=Path(__file__).resolve().parents[1]
bpy.ops.wm.read_factory_settings(use_empty=True);S=bpy.context.scene
with bpy.data.libraries.load(str(R/'scene/longwan_roadside_editable.blend'),link=False) as (src,dst):dst.materials=['Worn kerb coating','Concrete']
coat=bpy.data.materials['Worn kerb coating'];core=bpy.data.materials['Concrete']
# Use current authored maps even when the source library has earlier packed copies.
for node in coat.node_tree.nodes:
    if node.type=='TEX_IMAGE' and node.image:
        path=R/'materials/kerb-r03'/Path(node.image.filepath).name
        if path.exists():
            linear=node.image.colorspace_settings.name=='Non-Color'
            node.image=bpy.data.images.load(str(path),check_existing=False)
            if linear:node.image.colorspace_settings.name='Non-Color'
exec(compile((R/'source/curve_kerb.py').read_text(),str(R/'source/curve_kerb.py'),'exec'))
C=bpy.data.collections.new('Editable kerb examples');S.collection.children.link(C)
parent=bpy.data.objects.new('Kerb Examples',None);C.objects.link(parent)
straight,p1=create_curve_kerb(C,parent,coat,'01 Straight',[(0,0,0),(12,0,0)],seed=3,core=core)
corner,p2=create_curve_kerb(C,parent,coat,'02 Corner',[(0,5,0),(5,5,0),(9,7.5,0),(10.5,12,0)],seed=9,bezier=True,core=core)
scurve,p3=create_curve_kerb(C,parent,coat,'03 S Curve',[(0,15,0),(4,15,0),(7,17,0),(11,15.5,0),(15,16,0)],width=.8,ribs_enabled=False,seed=23,bezier=True,core=core)
def parameter(o,name,value):
    m=o.modifiers[0];key=next(x.identifier for x in m.node_group.interface.items_tree if x.item_type=='SOCKET' and x.in_out=='INPUT' and x.name==name)
    m[key]=value;o.update_tag();bpy.context.view_layer.update()
def stats(o):
    bpy.context.view_layer.update();deps=bpy.context.evaluated_depsgraph_get();ev=o.evaluated_get(deps);me=bpy.data.meshes.new_from_object(ev,preserve_all_data_layers=True,depsgraph=deps)
    a=np.array([v.co[:] for v in me.vertices]);assert len(a)>0,'Generator produced no geometry'
    bm=bmesh.new();bm.from_mesh(me);bad=sum(not e.is_manifold for e in bm.edges);bm.free();me.calc_loop_triangles()
    result={'vertices':len(a),'triangles':len(me.loop_triangles),'bounds_min':a.min(0).tolist(),'bounds_max':a.max(0).tolist(),'uv_layers':[u.name for u in me.uv_layers],'nonmanifold_edges':bad,'position_hash':hashlib.sha256(a.tobytes()).hexdigest()}
    if me.uv_layers.active:
        uv=np.array([u.uv[:] for u in me.uv_layers.active.data]);result['uv_hash']=hashlib.sha256(uv.tobytes()).hexdigest()
    bpy.data.meshes.remove(me);return result
base=stats(straight);assert 'UVMap' in base['uv_layers'],'Native UV layer missing';assert base['nonmanifold_edges']==0,base
parameter(straight,'Width m',.65);narrow=stats(straight);assert abs(narrow['bounds_max'][1]-narrow['bounds_min'][1]-.65)<.015
parameter(straight,'Width m',1);parameter(straight,'Ribs enabled',False);low=stats(straight);assert base['bounds_max'][2]-low['bounds_max'][2]>.020
parameter(straight,'Slope enabled',False);flat=stats(straight);assert abs(flat['bounds_max'][2]-.003)<.002
parameter(straight,'Slope enabled',True);parameter(straight,'Ribs enabled',True)
parameter(straight,'Use full path',False);parameter(straight,'Length m',6);short=stats(straight);assert abs(short['bounds_max'][0]-6)<.005
parameter(straight,'Use full path',True);parameter(straight,'Length m',12)
parameter(straight,'Wear seed',11);wear=stats(straight);assert wear['uv_hash']!=base['uv_hash'];parameter(straight,'Wear seed',3)
for p in p1.data.splines[0].points:p.co.z=.5
p1.data.update_tag();bpy.context.view_layer.update();raised=stats(straight);assert abs(raised['bounds_min'][2]-.42)<.01
for p in p1.data.splines[0].points:p.co.z=0
p1.data.update_tag();bpy.context.view_layer.update()
before=stats(corner);p2.data.splines[0].bezier_points[1].co.y+=1;p2.data.update_tag();bpy.context.view_layer.update();after=stats(corner);assert before['position_hash']!=after['position_hash'];p2.data.splines[0].bezier_points[1].co.y-=1;p2.data.update_tag();bpy.context.view_layer.update()
report={'scope':'Native Blender generator behavior; no game or physics tests','default_straight':base,'width_065':narrow,'ribs_disabled':low,'slope_and_ribs_disabled':flat,'length_6m':short,'raised_path_050':raised,'wear_changes_uv':wear['uv_hash']!=base['uv_hash'],'curve_edit_changes_geometry':before['position_hash']!=after['position_hash'],'examples':[stats(o) for o in [straight,corner,scurve]],'parameters_restored':True,'nominal_area_default_m2':12,'nominal_area_short_m2':6,'visual_review':'Pending actual rendered inspection'}
(R/'review/kerb-generator-checks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
def plain(name,c,rough=.8):
    m=bpy.data.materials.new(name);m.use_nodes=True;b=next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED');b.inputs['Base Color'].default_value=(*c,1);b.inputs['Roughness'].default_value=rough;return m
floor=plain('Neutral demonstration floor',(.085,.105,.115));clay=plain('Geometry inspection clay',(.40,.43,.42));white=plain('Example legend',(.62,.67,.66))
P=bpy.data.collections.new('Presentation');S.collection.children.link(P)
bpy.ops.mesh.primitive_plane_add(size=100,location=(7,8,-.081));o=bpy.context.object;o.name='Demonstration floor';o.data.materials.append(floor)
for old in list(o.users_collection):old.objects.unlink(o)
P.objects.link(o)
for body,x,y in [('01 / STRAIGHT',0,-1),('02 / CORNER',0,4),('03 / S-CURVE',0,14)]:
    cu=bpy.data.curves.new(body,'FONT');cu.body=body;cu.size=.35;cu.extrude=0;o=bpy.data.objects.new(body,cu);P.objects.link(o);o.location=(x,y,-.075);cu.materials.append(white)
world=bpy.data.worlds.new('Neutral example light');world.use_nodes=True;S.world=world;bg=next(n for n in world.node_tree.nodes if n.type=='BACKGROUND');bg.inputs['Color'].default_value=(.46,.52,.57,1);bg.inputs['Strength'].default_value=.30
light=bpy.data.lights.new('Raking daylight','SUN');light.energy=2;light.angle=.035;o=bpy.data.objects.new('Raking daylight',light);P.objects.link(o);o.rotation_euler=Vector((.5,.8,-1)).to_track_quat('-Z','Y').to_euler()
views=[('kerb_procedural_overview',(-9,-11,20),(7,8,.0),44),('kerb_ribs_close',(1.0,2.1,.65),(3.0,.62,.04),50)]
for name,pos,target,lens in views:
    ca=bpy.data.cameras.new(name);ca.lens=lens;ca.clip_end=150;o=bpy.data.objects.new(name,ca);P.objects.link(o);o.location=pos;o.rotation_euler=(Vector(target)-o.location).to_track_quat('-Z','Y').to_euler()
S.render.engine='CYCLES';S.cycles.samples=32;S.cycles.use_denoising=True;S.render.threads_mode='FIXED';S.render.threads=3;S.render.resolution_x=1600;S.render.resolution_y=1000;S.render.resolution_percentage=100;S.render.image_settings.file_format='PNG';S.view_settings.view_transform='AgX';S.view_settings.look='AgX - Medium High Contrast';S.unit_settings.system='METRIC';S.unit_settings.scale_length=1
S.camera=bpy.data.objects['kerb_procedural_overview'];S['game_integration']='NOT_RUN';S['generator']='Native Geometry Nodes with editable object path';C.asset_mark();C.asset_data.description='Real ribbed concrete kerb; edit path and native Geometry Nodes parameters.'
bpy.ops.object.select_all(action='DESELECT');straight.select_set(True);bpy.context.view_layer.objects.active=straight
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='PROPERTIES':area.spaces.active.context='MODIFIER'
        elif area.type=='VIEW_3D':
            area.spaces.active.region_3d.view_location=(6,7,0)
            area.spaces.active.region_3d.view_distance=26
            area.spaces.active.region_3d.view_rotation=S.camera.rotation_euler.to_quaternion()
            area.spaces.active.shading.type='MATERIAL'
bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(R/'scene/longwan_kerb_procedural.blend'))
for name,_,_,_ in views:
    for ob in P.objects:
        if ob.type=='FONT':ob.hide_render=name!='kerb_procedural_overview'
    S.camera=bpy.data.objects[name];S.render.filepath=str(R/'previews'/f'{name}.png');bpy.ops.render.render(write_still=True)
S.camera=bpy.data.objects['kerb_ribs_close'];bg.inputs['Strength'].default_value=.15;S.view_layers[0].material_override=clay;S.render.filepath=str(R/'previews/kerb_ribs_clay.png');bpy.ops.render.render(write_still=True);S.view_layers[0].material_override=None
print('KERB_GENERATOR_EXAMPLES_COMPLETE',flush=True)
