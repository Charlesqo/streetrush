"""Build a complete pit building from reviewed Poly Haven architectural components.
Keeps the acquired UVs/materials, adds wall backs, floors, roof and race-specific fittings.
Original files and the rejected layout prototype remain untouched.
"""
import bpy,math,json
from pathlib import Path
from mathutils import Vector,Matrix
ROOT=Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'review'/'native_factory_inspection.blend'),load_ui=False,use_scripts=False)
S=bpy.context.scene;deps=bpy.context.evaluated_depsgraph_get()
keys=['wall_door_garage_door_01','door_garage_door_01','wall_door_garage_centered_01','door_garage_centered_01','wall_window_centered_large_01','window_centered_large_01','wall_standard_standard_01','wall_pier_standard_01','wall_pier_corner_01','crown_standard_standard_01','crown_pier_corner_01','cornice01_standard_standard_01','base_standard_standard_01','wall_door_centered_small_01','door_centered_small_01']
T={}
for key in keys:
    src=bpy.data.objects[key];ev=src.evaluated_get(deps)
    me=bpy.data.meshes.new_from_object(ev,preserve_all_data_layers=True,depsgraph=deps)
    me.transform(Matrix.Translation(-src.matrix_world.translation)@src.matrix_world)
    T[key]=me
for ob in list(bpy.data.objects):bpy.data.objects.remove(ob,do_unlink=True)
for collection in list(S.collection.children):S.collection.children.unlink(collection)
COL=bpy.data.collections.new('Longwan_Pit_Building');S.collection.children.link(COL)
PARENT=bpy.data.objects.new('Longwan_Pit_Building',None);COL.objects.link(PARENT)
PARENT['asset_description']='18m three-bay circuit pit building, complete exterior and interior shell. Adapted from Poly Haven Modular Factory Facade (James Ray Cock, CC0), original UVs and PBR preserved.'
PARENT['units']='metres';PARENT['source_revision']='native-garage-01'
M={}
def principal(mat):return next(n for n in mat.node_tree.nodes if n.bl_idname=='ShaderNodeBsdfPrincipled')
def plain(name,color,rough=.55,metal=0):
    mat=bpy.data.materials.new(name);mat.use_nodes=True;bs=principal(mat)
    bs.inputs['Base Color'].default_value=(*color,1);bs.inputs['Roughness'].default_value=rough;bs.inputs['Metallic'].default_value=metal
    mat.diffuse_color=(*color,1);M[name]=mat;return mat
plain('Powder coated graphite',(.034,.047,.054),.40)
plain('Sign warm white',(.73,.76,.73),.53)
plain('Circuit red',(.48,.038,.021),.5)
plain('Galvanized fittings',(.56,.61,.63),.37,1)
plain('Black rubber',(.024,.029,.028),.91)
lamp=plain('Lamp diffuser',(.72,.8,.8),.35);principal(lamp).inputs['Emission Color'].default_value=(.80,.92,1,1);principal(lamp).inputs['Emission Strength'].default_value=1.4
def image_pbr(name,folder,stem,tile):
    mat=plain(name,(.3,.3,.3),.85);mat['tile_metres']=tile;bs=principal(mat)
    for role in ['diff','nor_gl','arm']:
        path=folder/f'{stem}_{role}_2k.jpg';im=bpy.data.images.load(str(path),check_existing=True)
        if role!='diff':im.colorspace_settings.name='Non-Color'
        n=mat.node_tree.nodes.new('ShaderNodeTexImage');n.image=im
        if role=='diff':mat.node_tree.links.new(n.outputs['Color'],bs.inputs['Base Color'])
        elif role=='nor_gl':
            normal=mat.node_tree.nodes.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.6
            mat.node_tree.links.new(n.outputs['Color'],normal.inputs['Color']);mat.node_tree.links.new(normal.outputs['Normal'],bs.inputs['Normal'])
        else:
            sep=mat.node_tree.nodes.new('ShaderNodeSeparateColor');mat.node_tree.links.new(n.outputs['Color'],sep.inputs['Color']);mat.node_tree.links.new(sep.outputs['Green'],bs.inputs['Roughness'])
    return mat
image_pbr('Apron concrete',ROOT/'sources/pbr/polyhaven/rough_concrete','rough_concrete',2)
image_pbr('Track asphalt',ROOT/'sources/pbr/refinement/asphalt_track','asphalt_track',2)
image_pbr('Paddock paving',ROOT/'sources/pbr/polyhaven/floor_pavement','floor_pavement',2)
def mesh(name,vs,fs,material,bevel=0):
    me=bpy.data.meshes.new(name);me.from_pydata(vs,[],fs);me.update();me.materials.append(M[material] if isinstance(material,str) else material)
    ob=bpy.data.objects.new(name,me);COL.objects.link(ob);ob.parent=PARENT
    uv=me.uv_layers.new(name='UVMap');tile=me.materials[0].get('tile_metres',1)
    for p in me.polygons:
        ax=max(range(3),key=lambda i:abs(p.normal[i]));axes=[(1,2),(0,2),(0,1)][ax]
        for li in p.loop_indices:
            v=me.vertices[me.loops[li].vertex_index].co;uv.data[li].uv=(v[axes[0]]/tile,v[axes[1]]/tile)
    if bevel:
        mod=ob.modifiers.new('Manufactured corner radius','BEVEL');mod.width=bevel;mod.segments=3
        mod=ob.modifiers.new('Weighted normals','WEIGHTED_NORMAL');mod.keep_sharp=True
    return ob
def box(name,p,d,mat,bevel=.006):
    vs=[(p[0]+x*d[0]/2,p[1]+y*d[1]/2,p[2]+z*d[2]/2) for x,y,z in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
    return mesh(name,vs,[(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)],mat,bevel)
def rod(name,a,b,r,mat,n=12):
    a,b=Vector(a),Vector(b);q=Vector((0,0,1)).rotation_difference((b-a).normalized());vs=[]
    for p in [a,b]:vs += [p+q@Vector((r*math.cos(i*math.tau/n),r*math.sin(i*math.tau/n),0)) for i in range(n)]
    fs=[tuple(reversed(range(n))),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return mesh(name,vs,fs,mat)
def text(name,body,p,size,mat='Sign warm white'):
    cu=bpy.data.curves.new(name,'FONT');cu.body=body;cu.size=size;cu.align_x='CENTER';cu.extrude=.0006;cu.resolution_u=3
    path=Path('/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf')
    if path.exists():cu.font=bpy.data.fonts.load(str(path),check_existing=True)
    ob=bpy.data.objects.new(name,cu);COL.objects.link(ob);ob.parent=PARENT;ob.location=p;ob.rotation_euler=(math.pi/2,0,0);cu.materials.append(M[mat]);return ob
def inner_skin(template,depth):
    vs=[];fs=[];uvs=[];ids=[]
    for poly in template.polygons:
        if poly.normal.y>-.75:continue
        verts=[template.vertices[template.loops[li].vertex_index].co for li in poly.loop_indices]
        if max(abs(v.y) for v in verts)>.032:continue
        start=len(vs);vs.extend([(v.x,depth,v.z) for v in reversed(verts)])
        fs.append(tuple(range(start,len(vs))));uvs.extend([template.uv_layers.active.data[li].uv[:] for li in reversed(poly.loop_indices)]);ids.append(poly.material_index)
    me=bpy.data.meshes.new('Native matching interior skin');me.from_pydata(vs,[],fs);me.update()
    for mat in template.materials:me.materials.append(mat)
    uv=me.uv_layers.new(name='UVMap')
    for li,value in enumerate(uvs):uv.data[li].uv=value
    for poly,idx in zip(me.polygons,ids):poly.material_index=idx
    return me
def place(key,anchor,angle=0,interior=False,label=None):
    ob=bpy.data.objects.new(label or key,T[key].copy());COL.objects.link(ob);ob.parent=PARENT;ob.location=anchor;ob.rotation_euler.z=angle
    ob['source_component']=key;ob['source']='Poly Haven / James Ray Cock / CC0'
    if interior:
        depth=max(v.co.y for v in ob.data.vertices)
        if depth<.05:
            mod=ob.modifiers.new('Masonry wall thickness 240mm','SOLIDIFY');mod.thickness=.24;mod.offset=-1
        else:
            back=bpy.data.objects.new('Matching interior masonry',inner_skin(ob.data,depth));COL.objects.link(back);back.parent=PARENT;back.location=anchor;back.rotation_euler.z=angle
    return ob
# Floors, foundations and complete, accessible volume.
box('Continuous foundation',(9,4.5,-.14),(18.25,9.25,.28),'Apron concrete',.012)
# Floor plates surround the stair opening instead of sealing it with a solid slab.
for p,d in [((9,3.625,3.0),(17.8,7.05,.20)),((9,8.675,3.0),(17.8,.45,.20)),((.775,7.8,3.0),(1.35,1.30,.20)),((11.975,7.8,3.0),(11.85,1.30,.20))]:
    box('Intermediate floor around stairwell',p,d,'Apron concrete',.004)
box('Roof structural slab',(9,4.5,6.05),(18.16,9.16,.18),'Apron concrete',.008)
box('Roof waterproofing',(9,4.5,6.151),(17.8,8.8,.022),'Track asphalt',.002)
for x in [6,12]:box('Ground floor bay partition',(x,3.2,1.45),(.18,5.8,2.9),'Apron concrete',.004)
for i in range(18):
    x=1.60+i*.255;top=(i+1)*3.10/18
    box('Internal access stair tread',(x,7.8,top-.025),(.265,1.18,.05),'Galvanized fittings',.003)
for y in [7.20,8.40]:
    rod('Stair structural stringer',(1.43,y,.04),(6.09,y,3.02),.06,'Powder coated graphite',8)
    rod('Stair handrail',(1.60,y,1.21),(5.935,y,4.14),.024,'Galvanized fittings')
    for i in [0,4,8,12,17]:
        x=1.60+i*.255;top=(i+1)*3.10/18
        rod('Stair baluster',(x,y,top),(x,y,top+1.04),.018,'Galvanized fittings')
for y in [7.14,8.46]:
    rod('Upper stairwell guard top',(1.45,y,4.14),(6.04,y,4.14),.023,'Powder coated graphite')
    rod('Upper stairwell guard mid',(1.45,y,3.62),(6.04,y,3.62),.018,'Powder coated graphite')
    for x in [1.45,3.0,4.5,6.04]:rod('Upper stairwell guard post',(x,y,3.10),(x,y,4.14),.021,'Powder coated graphite')
rod('Stairwell end guard',(1.45,7.14,4.14),(1.45,8.46,4.14),.023,'Powder coated graphite')
for x in [3,6,9,12,15]:
    box('Roof beam web',(x,4.5,5.88),(.06,8.55,.32),'Powder coated graphite',.003)
    for z in [5.73,6.02]:box('Roof beam flange',(x,4.5,z),(.18,8.55,.025),'Powder coated graphite',.002)
for x in [6,12]:box('Upper structural column',(x,4.5,4.48),(.15,.15,2.76),'Powder coated graphite',.004)
for right in [6,12,18]:
    place('wall_door_garage_door_01',(right,0,0),interior=True)
    place('door_garage_door_01',(right,0,0))
for level in [0,3]:
    for i in range(3):
        for x,anchor_y,angle in [(0,i*3,-math.pi/2),(18,(i+1)*3,math.pi/2)]:
            key='wall_window_centered_large_01' if level==3 else 'wall_standard_standard_01'
            place(key,(x,anchor_y,level),angle,interior=True)
            if level==3:place('window_centered_large_01',(x,anchor_y,level),angle)
    for i in range(6):
        # A rear staff access is part of the envelope, rather than a sealed facade.
        key='wall_door_centered_small_01' if level==0 and i==5 else 'wall_window_centered_large_01' if level==3 else 'wall_standard_standard_01'
        place(key,(i*3,9,level),math.pi,interior=True)
        if level==0 and i==5:place('door_centered_small_01',(i*3,9,level),math.pi)
        elif level==3:place('window_centered_large_01',(i*3,9,level),math.pi)
for i in range(6):
    place('wall_window_centered_large_01',((i+1)*3,0,3),interior=True)
    place('window_centered_large_01',((i+1)*3,0,3))
# Cornices and corner piers retain the kit's baked trims and real profile geometry.
for z,key in [(3,'cornice01_standard_standard_01'),(6,'crown_standard_standard_01')]:
    for i in range(6):
        place(key,((i+1)*3,0,z));place(key,(i*3,9,z),math.pi)
    for i in range(3):
        place(key,(0,i*3,z),-math.pi/2);place(key,(18,(i+1)*3,z),math.pi/2)
for z in [0,3]:
    for x,y,angle in [(0,0,0),(18,0,math.pi/2),(18,9,math.pi),(0,9,-math.pi/2)]:place('wall_pier_corner_01',(x,y,z),angle)
    for x in [6,12]:place('wall_pier_standard_01',(x,0,z))
for x,y,angle in [(0,0,0),(18,0,math.pi/2),(18,9,math.pi),(0,9,-math.pi/2)]:place('crown_pier_corner_01',(x,y,6),angle)
# Circuit wayfinding applied at plausible sizes to the existing lintel zones.
for index,x in enumerate([3.9,9.9,15.9],1):
    box('Garage bay identification',(x,-.105,2.905),(3.25,.024,.24),'Powder coated graphite',.007)
    for dx in [-1.48,1.48]:rod('Bay sign stand-off',(x+dx,-.103,2.905),(x+dx,.008,2.905),.011,'Galvanized fittings')
    box('Bay red identifier tab',(x-1.43,-.123,2.905),(.27,.012,.24),'Circuit red',.002)
    text('Garage number',f'{index:02}',(x-1.43,-.132,2.824),.18)
    text('Garage name','LONGWAN  /  MOTORSPORT',(x+.13,-.124,2.847),.095)
    box('Exterior service light housing',(x,-.20,2.65),(1.1,.19,.05),'Powder coated graphite',.009)
    box('Exterior service light lens',(x,-.207,2.621),(1.01,.14,.012),'Lamp diffuser',.003)
    for dx in [-.40,.40]:box('Service light wall bracket',(x+dx,-.07,2.67),(.035,.20,.05),'Powder coated graphite',.003)
    # Folded mounting bracket with full thickness and a connected conduit run.
    rod('Light electrical conduit',(x,-.12,2.655),(x,-.12,2.79),.009,'Galvanized fittings')
box('Circuit identity backing',(9,-.095,5.72),(8.6,.03,.48),'Powder coated graphite',.008)
for x in [5.1,7.7,10.3,12.9]:rod('Identity sign stand-off',(x,-.09,5.72),(x,.01,5.72),.013,'Galvanized fittings')
text('Circuit name','LONGWAN',(7.2,-.119,5.56),.37)
text('Circuit name secondary','PIT BUILDING  /  01–03',(11.0,-.119,5.67),.12)
# Real roof drainage and a rear service run; no unattached floating pipe ends.
for x in [.28,17.72]:
    for a,b in [((x,9.16,6.05),(x,9.25,5.76)),((x,9.25,5.76),(x,9.25,.18)),((x,9.25,.18),(x,9.38,.02))]:rod('Roof downpipe',a,b,.046,'Galvanized fittings')
    for z in [.55,2.2,3.9,5.4]:box('Downpipe wall saddle',(x,9.22,z),(.18,.13,.027),'Powder coated graphite',.005)
rod('Rear rain gutter',(.1,9.18,6.14),(17.9,9.18,6.14),.068,'Galvanized fittings')
# Presentation ground is kept in a separate collection, excluded from the building asset.
GROUND=bpy.data.collections.new('Presentation ground');S.collection.children.link(GROUND)
previous=COL;COL=GROUND;previous_parent=PARENT;PARENT=None
box('Context ground',(9,3,-.145),(160,140,.04),'Track asphalt',0)
box('Pit working apron',(9,-1.55,-.041),(22,3.1,.08),'Apron concrete',.006)
box('Trackside asphalt apron',(9,-6.8,-.045),(38,7.4,.09),'Track asphalt',0)
box('Side and rear paving',(9,5,-.09),(28,15,.16),'Paddock paving',0)
COL=previous;PARENT=previous_parent
# Neutral daylight reveals surfaces; source maps carry the appearance.
world=bpy.data.worlds.new('Longwan daylight');world.use_nodes=True;S.world=world
nt=world.node_tree;bg=next(n for n in nt.nodes if n.bl_idname=='ShaderNodeBackground');bg.inputs['Strength'].default_value=.65
env=nt.nodes.new('ShaderNodeTexEnvironment');env.image=bpy.data.images.load(str(ROOT/'sources/pbr/local-originals/sky/kloofendal_48d_partly_cloudy_puresky_2k.hdr'),check_existing=True);nt.links.new(env.outputs['Color'],bg.inputs['Color'])
presentation=bpy.data.collections.new('Presentation cameras and lighting');S.collection.children.link(presentation)
sun=bpy.data.lights.new('Afternoon sun','SUN');sun.energy=1.6;sun.angle=math.radians(2)
ob=bpy.data.objects.new('Afternoon sun',sun);presentation.objects.link(ob);ob.rotation_euler=Vector((.5,.65,-1)).to_track_quat('-Z','Y').to_euler()
views=[('native_garage_front',(-12,-18,9),(9,3,2.5),45),('native_garage_near',(-1.1,-5.6,2.25),(5.8,.0,1.65),48),('native_garage_rear',(30,24,11),(9,4,2.8),47)]
for name,pos,aim,lens in views:
    ca=bpy.data.cameras.new(name);ca.lens=lens;ca.clip_end=200
    ob=bpy.data.objects.new(name,ca);presentation.objects.link(ob);ob.location=pos;ob.rotation_euler=(Vector(aim)-ob.location).to_track_quat('-Z','Y').to_euler()
S.camera=bpy.data.objects['native_garage_front'];S.render.engine='CYCLES';S.cycles.samples=32;S.cycles.use_denoising=True;S.cycles.max_bounces=8;S.cycles.transmission_bounces=6
S.render.resolution_x=1600;S.render.resolution_y=1000;S.render.resolution_percentage=100;S.render.image_settings.file_format='PNG'
S.render.threads_mode='FIXED';S.render.threads=3;S.view_settings.view_transform='AgX';S.view_settings.look='AgX - Medium High Contrast';S.view_settings.exposure=.2
S.unit_settings.system='METRIC';S.unit_settings.scale_length=1
S['game_integration']='NOT_RUN';S['project']='Longwan pit building — native kit reconstruction';S['revision']='native-garage-01'
COL.asset_mark();COL.asset_data.description=previous_parent['asset_description']
bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'scene'/'longwan_pit_building_native.blend'))
for name,_,_,_ in views:
    S.camera=bpy.data.objects[name];S.render.filepath=str(ROOT/'previews'/f'{name}.png');bpy.ops.render.render(write_still=True);print('NATIVE_BUILDING_VIEW '+name,flush=True)
print('NATIVE_GARAGE_RECONSTRUCTION_COMPLETE')
