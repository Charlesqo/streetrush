"""Allow the full exposed width/slope range without raising the concrete underside.
Update saved native node graphs, confirming the reviewed default meshes stay unchanged.
"""
import bpy,json
import numpy as np
from pathlib import Path
R=Path(__file__).resolve().parents[1]
def verts(ob):
    bpy.context.view_layer.update();dep=bpy.context.evaluated_depsgraph_get();ev=ob.evaluated_get(dep);me=ev.to_mesh()
    a=np.array([v.co[:] for v in me.vertices]);ev.to_mesh_clear();return a
def param(ob,name,value):
    mod=ob.modifiers[0];key=next(s.identifier for s in mod.node_group.interface.items_tree if s.item_type=='SOCKET' and s.in_out=='INPUT' and s.name==name)
    old=mod[key];mod[key]=value;ob.update_tag();return old
report=[]
for file,names in [('longwan_kerb_procedural.blend',['01 Straight','02 Corner','03 S Curve']),('longwan_roadside_editable.blend',['Ribbed kerb | procedural'])]:
    bpy.ops.wm.open_mainfile(filepath=str(R/'scene'/file),load_ui=False,use_scripts=False)
    obs=[bpy.data.objects[n] for n in names];before=[verts(ob) for ob in obs]
    g=obs[0].modifiers[0].node_group
    extrude=next(n for n in g.nodes if n.bl_idname=='GeometryNodeExtrudeMesh')
    extrude.inputs['Offset'].links[0].from_node.inputs['Z'].default_value=-2.0
    for ob in obs:ob.update_tag()
    after=[verts(ob) for ob in obs]
    for a,b in zip(before,after):assert a.shape==b.shape and np.allclose(a,b,atol=.00001,rtol=0),'Reviewed default geometry changed'
    straight=obs[0];saved={}
    for name,value in [('Width m',2.5),('Cross slope deg',15),('Rib rise m',.12)]:saved[name]=param(straight,name,value)
    a=verts(straight)
    dep=bpy.context.evaluated_depsgraph_get();ev=straight.evaluated_get(dep);me=ev.to_mesh()
    bottoms=[sum(me.vertices[i].co.z for i in face.vertices)/len(face.vertices) for face in me.polygons if face.normal.z<-.95]
    ev.to_mesh_clear();assert bottoms and max(bottoms)<-.074,'Full parameter range lifts underside'
    for name,value in saved.items():param(straight,name,value)
    for ob,reference in zip(obs,before):assert np.allclose(verts(ob),reference,atol=.00001,rtol=0)
    bpy.ops.wm.save_as_mainfile(filepath=str(R/'scene'/file))
    report.append({'file':file,'default_geometry_unchanged_within_m':.00001,'largest_exposed_controls':{'width_m':2.5,'cross_slope_deg':15,'rib_rise_m':.12},'highest_downward_face_centre_m':max(bottoms),'default_controls_restored':True})
(R/'review/kerb-parameter-extent.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print('KERB_PARAMETER_EXTENT_FIXED',json.dumps(report),flush=True)
