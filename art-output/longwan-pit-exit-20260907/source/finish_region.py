"""Final visible-error corrections for the current delivery, no new scope."""
import bpy,bmesh,math,json
from pathlib import Path
from mathutils import Vector,noise
R=Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(R/'scene/longwan_region_editable.blend'),load_ui=False,use_scripts=False)
S=bpy.context.scene
def apron_z(y):return .150+(y-13.5)*.0011
def outer(x):
    t=max(0,min(1,(x-24)/24));return 13.5-5.65*(t*t*(3-2*t))
def lane_z(x,y):return .12+.022*max(0,min(1,(y-7.12)/(outer(x)-7.12)))
fixed=[]
for ob in list(S.objects):
    if ob.type=='MESH':
        if ob.name.startswith('Continuous service apron'):
            for v in ob.data.vertices:v.co.z=apron_z(v.co.y)
        elif ob.name.startswith(('Apron sawcut','Apron longitudinal sawcut')):
            for v in ob.data.vertices:v.co.z=apron_z(v.co.y)+.00065
        elif ob.name.startswith(('Garage work bay divider','Pit fast lane dash','Pit lane direction arrow','Pit merge limit')):
            # Paint is a surface, with no floating box sides or duplicate underside.
            bm=bmesh.new();bm.from_mesh(ob.data);bmesh.ops.delete(bm,geom=[f for f in bm.faces if f.normal.z<.5],context='FACES');bm.to_mesh(ob.data);bm.free()
            for v in ob.data.vertices:
                v.co.z=(apron_z(v.co.y) if ob.name.startswith('Garage work') else lane_z(v.co.x,v.co.y))+.0009
            fixed.append(ob.name)
        elif ob.name.startswith('Roof main cantilever'):
            for v in ob.data.vertices:v.co.z-=.18
            fixed.append(ob.name)
        elif ob.name.startswith('Roof compression strut'):
            for v in ob.data.vertices:
                if v.co.z>5.8:v.co.z-=.18
        elif ob.name.startswith('Localized pit tire contact'):
            for v in ob.data.vertices:v.co.z=(apron_z(v.co.y) if v.co.y>13.5 else lane_z(v.co.x,v.co.y))+.0012
        attr=ob.data.color_attributes.get('RegionTint')
        if attr and any(mat and mat.name.startswith(('Varied asphalt','Varied apron')) for mat in ob.data.materials):
            for face in ob.data.polygons:
                for li in face.loop_indices:
                    v=ob.matrix_world@ob.data.vertices[ob.data.loops[li].vertex_index].co
                    a=.92+.035*noise.noise(Vector((v.x*.18,v.y*.18,3.1)))+.015*noise.noise(Vector((v.x*.61,v.y*.61,11.0)))
                    attr.data[li].color=(a,a*.995,a*.985,1)
        ob.data.update()
    elif ob.type=='FONT' and ob.name.startswith('Working bay ground stencil'):ob.location.z=apron_z(ob.location.y)+.0012
S['art_status']='Current delivery closed; remaining visual gaps documented';S['revision']='region-delivery-20260907';S.camera=bpy.data.objects['region_01_overall']
bpy.ops.object.select_all(action='DESELECT');root=bpy.data.objects['Longwan_96m_Region'];root.select_set(True);bpy.context.view_layer.objects.active=root
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            area.spaces.active.region_3d.view_location=(0,6,2);area.spaces.active.region_3d.view_distance=100;area.spaces.active.region_3d.view_rotation=S.camera.rotation_euler.to_quaternion();area.spaces.active.shading.type='MATERIAL'
bpy.ops.wm.save_as_mainfile(filepath=str(R/'scene/longwan_region_editable.blend'))
(R/'review/region-final-corrections.json').write_text(json.dumps({'scope':'Current-round closeout only','corrections':['Ground markings conformed to apron/pit lane, box sides removed','Concrete apron slope flattened toward the drain','Overly periodic pavement colour replaced by subtle irregular vertex colour','Roof main beams lowered under the sheet'],'edited_markings_and_beams':len(fixed),'game_integration':'NOT_RUN'},indent=2))
for name in ['region_01_overall','region_02_driving','region_03_pit_work','region_04_control','region_05_stand','region_06_ground']:
    S.camera=bpy.data.objects[name];S.render.filepath=str(R/'previews'/f'{name}.png');bpy.ops.render.render(write_still=True);print('REGION_FINAL_VIEW_COMPLETE '+name,flush=True)
print('REGION_CURRENT_DELIVERY_COMPLETE',flush=True)
