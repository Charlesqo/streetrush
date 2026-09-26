import bpy,json
p='/Volumes/Storage/streetrush/art-output/longwan-pit-exit-20260907/scene/longwan_kerb_procedural.blend'
bpy.ops.wm.open_mainfile(filepath=p)
obj=next(o for o in bpy.data.objects if o.type=='MESH' and any(m.type=='NODES' and m.node_group and 'Path-driven' in m.node_group.name for m in o.modifiers))
m=next(m for m in obj.modifiers if m.type=='NODES');sockets={s.name:s.identifier for s in m.node_group.interface.items_tree if s.item_type=='SOCKET' and s.in_out=='INPUT'}
def measure():
 bpy.context.view_layer.update();e=obj.evaluated_get(bpy.context.evaluated_depsgraph_get());mesh=e.to_mesh();v=[x.co.copy() for x in mesh.vertices];r={'vertices':len(v),'min':[min(x[i] for x in v) for i in range(3)],'max':[max(x[i] for x in v) for i in range(3)]};e.to_mesh_clear();return r
r={'object':obj.name,'original':measure()};m[sockets['Width m']]=.65;obj.update_tag();r['width_065']=measure();m[sockets['Ribs enabled']]=False;obj.update_tag();r['ribs_off']=measure();path=m[sockets['Path']];spl=path.data.splines[0]
if spl.type=='BEZIER':spl.bezier_points[1].co.y+=2
else:spl.points[len(spl.points)//2].co.y+=2
path.data.update_tag();obj.update_tag();r['path_changed']=measure();r['source_saved']=False
open('/Volumes/Storage/streetrush/scratch/pit-game-preview-20260907/kerb-actual-check.json','w').write(json.dumps(r,indent=2));print(json.dumps(r))
