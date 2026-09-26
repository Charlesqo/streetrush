"""Assemble the locked 96m Longwan region from reviewed assets and revised support structures.
Standalone .blend; preserve every source and earlier prototype. Not game integration.
"""
import bpy,bmesh,math,random,json,sys
from pathlib import Path
from mathutils import Vector,Matrix
import numpy as np
R=Path(__file__).resolve().parents[1];random.seed(90931)
bpy.ops.wm.open_mainfile(filepath=str(R/'scene/longwan_pit_exit_editable.blend'),load_ui=False,use_scripts=False)
S=bpy.context.scene
keep_names=['A02_Race_Control','A03_Marshal_Post','A04_Trackside_Grandstand','F01_Pit_Exit_Signal','F02_Tool_Trolley','F03_Tyre_Rack','F05_Braking_Board','F06_Floodlight_-31','F06_Floodlight_30','F07_Timing_Gantry','F08_Scanned_Service_Barriers','D02_Control_Details']
keep_roots=[bpy.data.objects[n] for n in keep_names if n in bpy.data.objects]
keep=set(keep_roots)
for ob in keep_roots:keep.update(ob.children_recursive)
for ob in list(bpy.data.objects):
    if ob not in keep:bpy.data.objects.remove(ob,do_unlink=True)
for col in list(bpy.data.collections):
    if len(col.all_objects)==0:bpy.data.collections.remove(col)
REGION=bpy.data.objects.new('Longwan_96m_Region',None);S.collection.objects.link(REGION)
REGION['scope']='96m main straight / pit exit; three-bay building, control, marshal, stand and supporting facilities';REGION['art_status']='Assembly revision 01, pending actual visual review';REGION['game_integration']='NOT_RUN'
for ob in keep_roots:ob.parent=REGION
M={};exec(compile((R/'source/region_helpers.py').read_text(),str(R/'source/region_helpers.py'),'exec'))
garage_col=load_collection(R/'scene/longwan_pit_building_native.blend','Longwan_Pit_Building');S.collection.children.link(garage_col)
garage=next(o for o in garage_col.objects if o.type=='EMPTY' and o.parent is None);garage.parent=REGION;garage.location=(-31,18,.15)
road_source=load_collection(R/'scene/longwan_roadside_editable.blend','Roadside_24m')
M['Zinc']=next(m for m in bpy.data.materials if m.name.startswith('Weathered galvanized steel'))
pbr('Region concrete',R/'sources/pbr/polyhaven/rough_concrete','rough_concrete',1.23,.3)
pbr('Region asphalt',R/'sources/pbr/refinement/asphalt_track','asphalt_track',2,.65)
pbr('Region grass',R/'sources/pbr/region/leafy_grass','leafy_grass',2,.75)
pbr('Region gravel',R/'sources/pbr/polyhaven/gravel_stones','gravel_stones',2,.65)
pbr('Region paving',R/'sources/pbr/polyhaven/floor_pavement','floor_pavement',2,.5)
pbr('Roof metal',R/'sources/pbr/refinement/corrugated_iron_03','corrugated_iron_03',2,.15)
tinted(M['Region asphalt'],'Varied asphalt');tinted(M['Region grass'],'Varied grass');tinted(M['Region concrete'],'Varied apron');tinted(M['Region gravel'],'Varied gravel')
plain('Graphite finish',(.028,.041,.044),.48);plain('Circuit red finish',(.31,.029,.017),.54);plain('Warm white',(.65,.69,.66),.65);plain('Dark joints',(.022,.021,.017),.95)
plain('Seat graphite',(.037,.052,.055),.48);plain('Seat red',(.30,.043,.029),.51)
for name in ['Graphite finish','Circuit red finish','Seat graphite','Seat red']:
    n=M[name].node_tree.nodes;l=M[name].node_tree.links;tex=n.new('ShaderNodeTexImage');tex.image=im(R/'sources/pbr/ambientcg/Metal038/Metal038_2K-JPG_NormalGL.jpg',True)
    q=n.new('ShaderNodeNormalMap');q.inputs['Strength'].default_value=.045;l.new(tex.outputs['Color'],q.inputs['Color']);l.new(q.outputs['Normal'],principal(M[name]).inputs['Normal'])
def macro(v):
    x,y=v.x,v.y;a=.88+.07*math.sin(x*.19+y*.29)+.03*math.sin(x*.63-y*.23)
    return (a,a*.995,a*.975)
def grass_tint(v):
    a=.68+.17*math.sin(v.x*.11+v.y*.29)+.07*math.sin(v.x*.51-v.y*.37)
    return (a*.84,a,a*.79)
def apply_tint(ob,fn):
    me=ob.data
    attr=me.color_attributes.get('RegionTint') or me.color_attributes.new(name='RegionTint',type='FLOAT_COLOR',domain='CORNER')
    for face in me.polygons:
        for li in face.loop_indices:attr.data[li].color=(*fn(ob.matrix_world@me.vertices[me.loops[li].vertex_index].co),1)
def replace_materials(objects):
    for ob in objects:
        if ob.type!='MESH':continue
        for slot in ob.material_slots:
            if not slot.material:continue
            name=slot.material.name
            target='Zinc' if name.startswith('Galvanized') else 'Graphite finish' if name.startswith('Graphite') else 'Circuit red finish' if name.startswith('Vermilion') else 'Region concrete' if name in ['Concrete','Concrete_Scan','Concrete_Scan.001'] else None
            if target:slot.material=M[target]
replace_materials(keep)
# Four aligned modules; duplicate fence end assemblies are omitted at internal joins.
source_objects=list(road_source.all_objects)
for index,anchor in enumerate([48,24,0,-24]):
    col=bpy.data.collections.new(f'Track_edge_{index+1:02}');S.collection.children.link(col);mapping={}
    for old in source_objects:
        if old.type=='MESH' and old.parent and old.parent.name.startswith('E08') and index<3:
            bounds=[v.co.x for v in old.data.vertices]
            if bounds and max(bounds)-min(bounds)<.8 and abs((max(bounds)+min(bounds))/2-24)<.02:continue
        ob=old.copy()
        if old.data and old.type in {'MESH','CURVE'}:ob.data=old.data.copy()
        col.objects.link(ob);mapping[old]=ob
    for old,ob in mapping.items():
        ob.parent=mapping.get(old.parent,REGION)
        for mod in ob.modifiers:
            if mod.type=='NODES':
                for item in mod.node_group.interface.items_tree:
                    if item.item_type=='SOCKET' and item.in_out=='INPUT' and item.name=='Path':mod[item.identifier]=mapping.get(mod[item.identifier],mod[item.identifier])
                    elif item.item_type=='SOCKET' and item.in_out=='INPUT' and item.name=='Wear seed':mod[item.identifier]=3+index*7
        if old.type=='EMPTY' and old.parent is None:
            ob.location=(anchor,-7,0);ob.rotation_euler.z=math.pi;ob.name=f'Roadside_module_{index+1:02}'
    bpy.context.view_layer.update()
    for old,ob in mapping.items():
        if ob.type!='MESH':continue
        if ob.name.startswith('14m race surface') or ob.name.startswith('Paved recovery strip'):
            bm=bmesh.new();bm.from_mesh(ob.data);bmesh.ops.subdivide_edges(bm,edges=list(bm.edges),cuts=23,use_grid_fill=True);bm.to_mesh(ob.data);bm.free()
            ob.data.materials.clear();ob.data.materials.append(M['Varied asphalt']);apply_tint(ob,macro)
        elif ob.name.startswith('Mown dry grass verge'):
            ob.data.materials.clear();ob.data.materials.append(M['Varied grass']);apply_tint(ob,grass_tint)
        elif ob.name.startswith('Short verge grass blades'):
            for i,slot in enumerate(ob.material_slots):
                mat=slot.material.copy();mat.name='Mixed mown blade';principal(mat).inputs['Base Color'].default_value=(*[(.072,.12,.039),(.16,.205,.071),(.24,.23,.098),(.11,.16,.052)][i%4],1);slot.material=mat
        elif ob.name.startswith('Formed W-beam') and index<3 and max(v.co.x for v in ob.data.vertices)>23.99:
            for v in ob.data.vertices:
                if v.co.x>23.99:v.co.x+=.16
            for uv in ob.data.uv_layers.active.data:
                if uv.uv.x>23.99:uv.uv.x+=.16
    # Independent copies retain native curve modifiers and source material connections.
for ob in source_objects:bpy.data.objects.remove(ob,do_unlink=True)
bpy.data.collections.remove(road_source)
# Spatial organization: work apron, pit lane, pedestrian paths and planted margins.
begin('Region_surfaces')
def pit_outer(x):
    t=max(0,min(1,(x-24)/24));return 13.5-5.65*(t*t*(3-2*t))
terrain('Continuous service apron',-47,24,13.5,29.0,'Varied apron',.65,macro,lambda x,y:.148+.014*math.sin(x*.07)*math.sin(y*.3))
strip('Pit lane and tapered exit',np.linspace(-48,48,241),7.12,pit_outer,.12,.142,'Varied asphalt',macro)
terrain('Rear paddock service paving',-48,48,29.05,34.0,'Region paving',.6,zfun=lambda x,y:.155)
terrain('Spectator access promenade',-48,48,-20.3,-17.9,'Region paving',.6,zfun=lambda x,y:-.018)
terrain('Outer spectator ground',-48,48,-31,-20.32,'Varied grass',.5,grass_tint,lambda x,y:-.035+.018*math.sin(x*.2)*math.sin(y*.4))
terrain('Rear planted margin',-48,48,34,41,'Varied grass',.55,grass_tint,lambda x,y:.12+.055*math.sin(x*.13)*math.sin(y*.36))
strip('Pit exit grass wedge',np.linspace(24,48,97),lambda x:pit_outer(x)+.02,29,.155,.165,'Varied grass',grass_tint)
terrain('Marshal service pad',26.5,33,15.0,20.0,'Varied apron',.5,macro,lambda x,y:.182)
# Small expansion joints give the concrete apron a plausible pouring scale.
for x in np.arange(-47,24.1,4.5):box('Apron sawcut',(x,21.2,.165),(.008,15.35,.003),'Dark joints',0)
for y in [17.5,22,26.5]:box('Apron longitudinal sawcut',(-11.5,y,.166),(71,.008,.003),'Dark joints',0)
# Working bays align to the acquired building, with a clear pedestrian route behind them.
white=next(m for m in bpy.data.materials if m.name.startswith('Track limit paint'));M['Paint white']=white
for x in [-31,-25,-19,-13]:box('Garage work bay divider',(x,16.0,.176),(.10,3.4,.002),'Paint white',0)
for x in [-28,-22,-16]:
    label('Working bay ground stencil','PIT',(x,14.48,.179),.46,'Warm white',rot=(0,0,0))
strip('Pit merge limit',np.linspace(-48,48,241),lambda x:pit_outer(x)-.13,lambda x:pit_outer(x)-.01,.150,.150,'Paint white')
for x in np.arange(-45,21,5):box('Pit fast lane dash',(x,10.35,.15),(2.4,.10,.003),'Paint white',0)
for x in np.arange(-42,23,7):
    mesh('Pit lane direction arrow',[(x-1.0,10.9,.153),(x+.35,10.9,.153),(x+.35,10.64,.153),(x+1.1,11.15,.153),(x+.35,11.66,.153),(x+.35,11.4,.153),(x-1.,11.4,.153)],[(0,1,2,3,4,5,6)],'Paint white')
# Pit divider: cast concrete modules, steel rails and a deliberate exit terminus.
begin('Pit_divider')
for x in np.arange(-47.5,21,2.0):
    vs=[(xx,yy,zz) for xx in [x,x+1.97] for yy,zz in [(7.30,.12),(8.12,.12),(7.99,.36),(7.87,.54),(7.85,1.12),(7.57,1.12),(7.55,.54),(7.43,.36)]];n=8
    mesh('Cast pit separator',vs,[tuple(reversed(range(n))),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)],'Region concrete',.006)
    for xx in [x+.23,x+1.75]:tube('Divider lifting pocket',(xx,7.53,.65),(xx,7.52,.65),.025,'Dark joints',12)
for x in np.arange(-46.5,20,4):
    box('Pit divider fence post',(x,7.73,1.76),(.065,.065,1.4),'Zinc')
    for z in [1.27,2.35]:tube('Pit wall handrail',(x-2,7.73,z),(min(x+2,21),7.73,z),.020,'Zinc',10)
    box('Pit wall post base',(x,7.73,1.15),(.18,.16,.025),'Zinc',.003)
# Preserve the detailed original signal and move it to the actual merge start.
if 'F01_Pit_Exit_Signal' in bpy.data.objects:bpy.data.objects['F01_Pit_Exit_Signal'].location=(22,9.4,.13)
if 'F02_Tool_Trolley' in bpy.data.objects:bpy.data.objects['F02_Tool_Trolley'].location=(-25.8,17.1,.16)
if 'F03_Tyre_Rack' in bpy.data.objects:bpy.data.objects['F03_Tyre_Rack'].location=(-32.9,19.3,.17)
if 'F08_Scanned_Service_Barriers' in bpy.data.objects:bpy.data.objects['F08_Scanned_Service_Barriers'].location=(14.6,18.3,.16)
if 'F05_Braking_Board' in bpy.data.objects:bpy.data.objects['F05_Braking_Board'].location=(35,-14.2,.02)
T=load_native_templates()
exec(compile((R/'source/region_structures.py').read_text(),str(R/'source/region_structures.py'),'exec'))
exec(compile((R/'source/region_ground_details.py').read_text(),str(R/'source/region_ground_details.py'),'exec'))
begin('Region_presentation')
terrain('Presentation terrain',-105,115,-95,90,'Varied grass',3,grass_tint,lambda x,y:-.20+.035*math.sin(x*.08)*math.cos(y*.06))
world=bpy.data.worlds.new('Longwan region daylight');world.use_nodes=True;S.world=world;bg=next(n for n in world.node_tree.nodes if n.type=='BACKGROUND');bg.inputs['Strength'].default_value=.48
env=world.node_tree.nodes.new('ShaderNodeTexEnvironment');env.image=im(R/'sources/pbr/local-originals/sky/kloofendal_48d_partly_cloudy_puresky_2k.hdr');world.node_tree.links.new(env.outputs['Color'],bg.inputs['Color'])
sun=bpy.data.lights.new('Region afternoon sun','SUN');sun.energy=2.1;sun.angle=math.radians(1.0);o=bpy.data.objects.new('Region afternoon sun',sun);C.objects.link(o);o.rotation_euler=Vector((.45,.55,-1)).to_track_quat('-Z','Y').to_euler()
views=[('region_01_overall',(-63,-53,39),(-4,8,3.2),40),('region_02_driving',(-42,-1,1.25),(18,9,2.8),31),('region_03_pit_work',(-37,10,2.9),(-20,20,2.8),37),('region_04_control',(22,8,6.1),(8,22,5.7),40),('region_05_stand',(-33,-12,4),(-11,-24,3),42),('region_06_ground',(14,-10.8,.83),(4,-14.8,.18),40)]
for name,pos,target,lens in views:
    ca=bpy.data.cameras.new(name);ca.lens=lens;ca.clip_end=350;o=bpy.data.objects.new(name,ca);C.objects.link(o);o.location=pos;o.rotation_euler=(Vector(target)-o.location).to_track_quat('-Z','Y').to_euler()
S.render.engine='CYCLES';S.cycles.samples=24;S.cycles.use_denoising=True;S.cycles.transparent_max_bounces=12;S.render.threads_mode='FIXED';S.render.threads=3;S.render.resolution_x=1600;S.render.resolution_y=1000;S.render.resolution_percentage=75;S.render.image_settings.file_format='PNG';S.view_settings.view_transform='AgX';S.view_settings.look='AgX - Medium High Contrast';S.view_settings.exposure=0
S.camera=bpy.data.objects[views[0][0]];S.unit_settings.system='METRIC';S['revision']='region-01';S['game_integration']='NOT_RUN';S['art_status']='IN_PROGRESS'
for image in list(bpy.data.images):
    if image.users==0:bpy.data.images.remove(image)
bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(R/'scene/longwan_region_editable.blend'))
for name,_,_,_ in views[:3]:
    S.camera=bpy.data.objects[name];S.render.filepath=str(R/'previews'/f'{name}.png');bpy.ops.render.render(write_still=True);print('REGION_VIEW_COMPLETE '+name,flush=True)
print('REGION_BUILD_COMPLETE',flush=True)
