import bpy,pathlib,json
root=pathlib.Path('/Volumes/Storage/streetrush')
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(root/'public/scenery/longwan/venue.gltf'))
records=[]
for o in list(bpy.data.objects):
 if o.type!='MESH':continue
 before=len(o.data.polygons)
 if before>1200:
  bpy.context.view_layer.objects.active=o
  m=o.modifiers.new('Runtime silhouette reduction','DECIMATE');m.ratio=.18 if before>20000 else .45;m.use_collapse_triangulate=True
  bpy.ops.object.modifier_apply(modifier=m.name)
 records.append({'name':o.name,'before_faces':before,'after_faces':len(o.data.polygons)})
bpy.ops.export_scene.gltf(filepath='/tmp/streetrush-venue-optimized.glb',export_format='GLB',export_apply=True,export_image_format='AUTO',export_cameras=False,export_lights=False)
(root/'scratch/pit-game-preview-20260907/venue-decimation.json').write_text(json.dumps(records,indent=2))
print('OPTIMIZED',sum(r['before_faces'] for r in records),sum(r['after_faces'] for r in records),flush=True)
