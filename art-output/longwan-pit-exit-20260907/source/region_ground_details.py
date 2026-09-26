"""Grass, surface deposits and purposeful site details for the locked region."""
# Combine the author's registered alpha with diffuse, preserving the originals.
F=R/'sources/native-models/grass_medium_01';derived=R/'materials/region';derived.mkdir(exist_ok=True)
path=derived/'grass_medium_01_base_alpha.png'
assert path.exists(),'Run the source-preserving alpha channel preparation before Blender.'
grass=plain('Native grass foliage',(.1,.2,.05),.84);n=grass.node_tree.nodes;l=grass.node_tree.links;b=principal(grass)
tex=n.new('ShaderNodeTexImage');tex.image=im(path);l.new(tex.outputs['Color'],b.inputs['Base Color']);l.new(tex.outputs['Alpha'],b.inputs['Alpha']);grass.surface_render_method='DITHERED'
tex=n.new('ShaderNodeTexImage');tex.image=im(F/'textures/grass_medium_01_nor_gl_1k.exr',True);nm=n.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.65;l.new(tex.outputs['Color'],nm.inputs['Color']);l.new(nm.outputs['Normal'],b.inputs['Normal'])
tex=n.new('ShaderNodeTexImage');tex.image=im(F/'textures/grass_medium_01_rough_1k.exr',True);l.new(tex.outputs['Color'],b.inputs['Roughness'])
keys=['grass_medium_01_mid_b_LOD1','grass_medium_01_small_b_LOD1','grass_medium_01_tall_a_LOD1','grass_medium_01_tiny_a_LOD0']
with bpy.data.libraries.load(str(F/'grass_medium_01_1k.blend'),link=False) as (src,dst):dst.objects=list(keys)
templates=[]
for src in dst.objects:
    me=src.data.copy();me.transform(src.matrix_basis.to_3x3().to_4x4());coords=np.array([v.co[:] for v in me.vertices]);lo,hi=coords.min(0),coords.max(0);centre=Vector(((lo[0]+hi[0])/2,(lo[1]+hi[1])/2,lo[2]))
    for v in me.vertices:v.co-=centre
    me.materials.clear();me.materials.append(grass);templates.append(me);bpy.data.objects.remove(src,do_unlink=True)
begin('Native_vegetation')
for i in range(710):
    if i<470:
        x=random.uniform(-47.7,47.7);y=random.uniform(-16.8,-12.6)
        # Keep the promenade and concrete anchor pads clear.
        if abs(y+13.45)<.35 and abs((x-48)%4)<.3:continue
        z=-.022
    elif i<610:x=random.uniform(-47,47);y=random.uniform(34.2,36.5);z=.10
    else:x=random.uniform(27,46);y=random.uniform(15.5,26);z=.153
    ob=bpy.data.objects.new('Native grass tuft',random.choice(templates));C.objects.link(ob);ob.parent=P;ob.location=(x,y,z);ob.rotation_euler.z=random.uniform(0,math.tau);a=random.uniform(.75,1.20);ob.scale=(a,a,a*random.uniform(.55,.9));ob['source']='Poly Haven / Rob Tuytel and Rico Cilliers / CC0';ob['lod_source']='LOD1, tiny variant LOD0'
# Short service bollards protect door approaches and signal equipment.
begin('Site_fittings')
for x,y in [(-31.7,17.7),(-12.3,17.7),(2.1,19.5),(10.4,19.5),(27.2,15.2),(31.7,15.2)]:
    tube('Protective bollard',(x,y,.18),(x,y,1.12),.071,'Circuit red finish',16)
    tube('Bollard reflective band',(x,y,.87),(x,y,1.01),.072,'Warm white',16)
    box('Bollard bolted base',(x,y,.195),(.25,.25,.04),'Zinc')
    for dx in [-.084,.084]:
        for dy in [-.084,.084]:tube('Bollard anchor',(x+dx,y+dy,.21),(x+dx,y+dy,.238),.009,'Zinc',6)
# Field drain in front of the working bays: grate geometry and recess at correct elevation.
begin('Pit_working_drain')
for k in range(23):
    x=-33+k
    box('Apron drain recess',(x+.5,13.82,.087),(.994,.24,.085),'Dark joints',0)
    for y in [13.70,13.94]:box('Drain cast rim',(x+.5,y,.151),(.994,.018,.023),'Zinc',.001)
    for j in range(24):box('Apron slotted grate',(x+.035+j*.041,13.82,.145),(.010,.22,.025),'Graphite finish',.001)
# Asphalt repairs and fines occur at construction edges and the used pit lane.
begin('Surface_repairs')
patch=plain('Asphalt repair binder',(.041,.038,.035),.78)
tex=patch.node_tree.nodes.new('ShaderNodeTexImage');tex.image=im(R/'sources/pbr/refinement/asphalt_track/asphalt_track_nor_gl_2k.jpg',True);nm=patch.node_tree.nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.35;patch.node_tree.links.new(tex.outputs['Color'],nm.inputs['Color']);patch.node_tree.links.new(nm.outputs['Normal'],principal(patch).inputs['Normal'])
for x,y,w,h in [(-34,12.2,2.1,.8),(-8,8.7,3.6,1.0),(20.4,12.7,1.2,.45)]:
    vs=[(x+dx*w,y+dy*h,.156) for dx,dy in [(-.5,-.43),(-.12,-.52),(.47,-.44),(.52,.23),(.38,.48),(-.41,.52),(-.53,.10)]]
    mesh('Localized asphalt utility repair',vs,[tuple(range(len(vs)))],patch)
# Faint contact deposits reuse the reviewed photographic asphalt decal, located by use.
mat=next(m for m in bpy.data.materials if m.name.startswith('Rubber contact trace'));M['Rubber contact']=mat
for x,y,length,width in [(-28,15.0,2.2,.22),(-22,15.5,2.1,.22),(-16,15.0,2.9,.26),(5,11.8,7,.30),(27,10.7,7.7,.24)]:
    ob=mesh('Localized pit tire contact',[(x-length/2,y-width/2,.181),(x+length/2,y-width/2,.181),(x+length/2,y+width/2,.181),(x-length/2,y+width/2,.181)],[(0,1,2,3)],mat)
    for item,uv in zip(ob.data.uv_layers.active.data,[(0,0),(1,0),(1,1),(0,1)]):item.uv=uv
    ob.visible_shadow=False
report={'native_grass_source':'Poly Haven grass_medium_01 / Rob Tuytel and Rico Cilliers / CC0','grass_source_objects':keys,'alpha_derivative':'materials/region/grass_medium_01_base_alpha.png','ground_source':'Poly Haven leafy_grass / Charlotte Baglioni / CC0','status':'Pending actual assembled render inspection'}
(R/'review/region-ground-sources.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
