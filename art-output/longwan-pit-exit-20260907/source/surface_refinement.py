"""Art refinement executed in the scene builder's namespace.
Real acquired mesh details and image-based, portable PBR surfaces.
Source packages remain unmodified under sources/.
"""

def load_model_parts(asset):
    old=set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(ROOT/'sources'/'free-models'/asset/f'{asset}_2k.gltf'))
    added=set(bpy.data.objects)-old
    parts={}
    for ob in added:
        if ob.type!='MESH':continue
        data=ob.data.copy();data.transform(ob.matrix_world)
        points=np.array([v.co[:] for v in data.vertices])
        lo=points.min(axis=0);hi=points.max(axis=0)
        origin=Vector(((lo[0]+hi[0])/2,hi[1],lo[2]))
        if asset=='modular_electric_cables':
            # Asymmetric side ports shift the bounding-box centre away from the pipe axis.
            # The author's object origin carries the actual connection axis.
            origin.x=ob.matrix_world.translation.x
        for v in data.vertices:v.co-=origin
        parts[ob.name]=(data,hi-lo)
    for ob in added:bpy.data.objects.remove(ob,do_unlink=True)
    return parts

def place_scanned(parts,key,position,rotation=0,ratio=None):
    data,size=parts[key]
    ob=bpy.data.objects.new(key,data);COL.objects.link(ob);ob.parent=PARENT
    ob.location=position;ob.rotation_euler.z=rotation
    ob['source']='Poly Haven / CC0';ob['source_part']=key
    if ratio:
        mod=ob.modifiers.new('Realtime reduction; original scan preserved','DECIMATE');mod.ratio=ratio
    for mat in data.materials:
        if mat:M.setdefault(mat.name,mat)
    return ob

def acquired_details():
    barriers=load_model_parts('concrete_road_barrier')
    begin('F08_Scanned_Service_Barriers',(4.5,15.15,0),'Three reclaimed concrete barriers protecting service equipment; CC0 Poly Haven model, reduced for realtime, original preserved.')
    for x,rot in [(0,.018),(1.65,-.025),(3.31,.035)]:
        place_scanned(barriers,'concrete_road_barrier',(x,0,0),rot,.20)
    electrics=load_model_parts('modular_electric_cables')
    begin('D03_Garage_Electrical_Services',(-16,20,0),'Acquired PBR industrial outlets and junction boxes connected by authored metal conduit; 1:1 physical scale.')
    for x in [-10.2,-3.4,3.4]:
        place_scanned(electrics,'cable_box_3way',(x,-5.202,1.88))
        place_scanned(electrics,'cable_plug_covered',(x,-5.205,1.13))
        cyl('Unused junction branch blanking cap',(x+.101,-5.221,1.98),.009,.010,'Galvanized',6,(1,0,0))
        tube('Garage supply conduit',[(x,-5.218,2.08),(x,-5.218,3.14),(x+.18,-5.218,3.31),(x+.18,-5.218,4.16)],.012,'Galvanized')
        tube('Outlet conduit',[(x,-5.22,1.88),(x,-5.22,1.28)],.011,'Galvanized')
        for z in [1.47,2.44,2.90]:
            box('Conduit saddle fixing',(x,-5.232,z),(.060,.013,.021),'Galvanized',.002)
            for dx in [-.023,.023]:
                cyl('Conduit saddle M4 screw washer',(x+dx,-5.242,z),.005,.004,'Galvanized',12,(0,1,0))
                cyl('Conduit saddle M4 screw head',(x+dx,-5.245,z),.003,.003,'Graphite',6,(0,1,0))

def portable_image_material(name,folder,stem,tile,base_tint=None,normal_strength=1,metal=0):
    """Accept official separated PBR roles, retain metric UVs and exportable nodes."""
    folder=Path(folder);files=list(folder.rglob('*'))
    def find_role(roles):
        for role in roles:
            found=[p for p in files if p.is_file() and role in p.stem and p.suffix.lower() in {'.jpg','.png','.exr'}]
            if found:return sorted(found,key=lambda p:(p.suffix=='.exr',len(p.name)))[0]
        return None
    paths={'diff':find_role(['_diff_','_color_']), 'normal':find_role(['_nor_gl_']),
           'rough':find_role(['_rough_']), 'arm':find_role(['_arm_'])}
    if not paths['diff'] or not paths['normal']:return None
    old=M.get(name)
    mat=pbr(name+'_Scan',(.3,.3,.3),.8,metal,tile=tile)
    bs=principled_node(mat)
    for role,path in paths.items():
        if not path:continue
        im=image_file(path,role!='diff')
        if role=='diff' and base_tint:
            px=np.empty(len(im.pixels),dtype=np.float32);im.pixels.foreach_get(px);px=px.reshape((im.size[1],im.size[0],4))
            lum=px[:,:,:3].mean(axis=2)
            # A tint derivative preserves all aggregate information and is labelled as authored.
            rgb=np.stack([lum*c for c in base_tint],axis=2)
            im=generated_map(name+'_ScanTint_BaseColor',rgb)
        node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=im
        if role=='diff':mat.node_tree.links.new(node.outputs['Color'],bs.inputs['Base Color'])
        elif role=='normal':
            nm=mat.node_tree.nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=normal_strength
            mat.node_tree.links.new(node.outputs['Color'],nm.inputs['Color']);mat.node_tree.links.new(nm.outputs['Normal'],bs.inputs['Normal'])
        elif role=='rough':mat.node_tree.links.new(node.outputs['Color'],bs.inputs['Roughness'])
        elif not paths['rough']:
            sep=mat.node_tree.nodes.new('ShaderNodeSeparateColor');mat.node_tree.links.new(node.outputs['Color'],sep.inputs['Color'])
            mat.node_tree.links.new(sep.outputs['Green'],bs.inputs['Roughness'])
    if old:
        previous_tile=old.get('tile_metres',1)
        for ob in list(S.objects):
            if ob.type!='MESH':continue
            changed=False
            for slot in ob.material_slots:
                if slot.material==old:slot.material=mat;changed=True
            if changed and ob.data.uv_layers.active:
                for uv in ob.data.uv_layers.active.data:uv.uv*=previous_tile/tile
    M[name]=mat
    mat['source']='Poly Haven / CC0';mat['source_directory']=str(folder.relative_to(ROOT))
    return mat

def reassign_material(old,new):
    previous_tile=old.get('tile_metres',1);new_tile=new.get('tile_metres',1)
    for ob in list(S.objects):
        if ob.type!='MESH':continue
        changed=False
        for slot in ob.material_slots:
            if slot.material==old:slot.material=new;changed=True
        if changed and ob.data.uv_layers.active:
            for uv in ob.data.uv_layers.active.data:uv.uv*=previous_tile/new_tile

def tint_scanned_material(target,source,color,contrast=.15):
    src=M[source];old=M.get(target);mat=src.copy();mat.name=target+'_ScanBased'
    bs=principled_node(mat)
    incoming=bs.inputs['Base Color'].links
    if not incoming:return
    tex=incoming[0].from_node
    if tex.bl_idname!='ShaderNodeTexImage':return
    im=tex.image
    px=np.empty(len(im.pixels),dtype=np.float32);im.pixels.foreach_get(px);px=px.reshape((im.size[1],im.size[0],4))
    lum=px[:,:,:3].mean(axis=2)
    detail=(lum/(float(lum.mean())+.0001)-1)*contrast+1
    im=generated_map(target+'_PhotographicDetail_BaseColor',np.stack([detail*c for c in color],axis=2))
    tex.image=im
    if old:reassign_material(old,mat)
    M[target]=mat;mat['surface_treatment']='Authored coating with retained scanned surface normal and microdetail'

def paint_surface_refinement():
    tint_scanned_material('GreenRunoff','Asphalt',(.032,.145,.100),.45)
    tint_scanned_material('AsphaltPatch','Asphalt',(.06,.066,.07),.65)
    tint_scanned_material('PaintWhite','Asphalt',(.57,.60,.57),.20)
    # Kerb coating inherits real cement pores, while geometric core remains visible at chips.
    source=M['Concrete'];normal_source=principled_node(source).inputs['Normal'].links[0].from_node
    source_image=normal_source.inputs['Color'].links[0].from_node.image
    for key,mat in M.items():
        if not key.startswith('Kerb_') or '_Worn_' not in key:continue
        tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=source_image
        nm=mat.node_tree.nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.46
        mat.node_tree.links.new(tex.outputs['Color'],nm.inputs['Color'])
        mat.node_tree.links.new(nm.outputs['Normal'],principled_node(mat).inputs['Normal'])

def replace_gravel_geometry(height_path):
    """Height is baked into editable mesh vertices, not Cycles-only displacement."""
    global COL,PARENT
    for ob in list(S.objects):
        if ob.name.startswith(('Shallow gravel bed','Scattered shoulder gravel')):
            bpy.data.objects.remove(ob,do_unlink=True)
    PARENT=bpy.data.objects['G01_Track_and_Runoff'];COL=PARENT.users_collection[0]
    im=image_file(height_path,True)
    px=np.empty(len(im.pixels),dtype=np.float32);im.pixels.foreach_get(px);px=px.reshape((im.size[1],im.size[0],4))[:,:,0]
    low,high=np.percentile(px,[2,98]);px=np.clip((px-low)/max(.00001,high-low),0,1)
    # More geometric sampling in the inspectable road-edge segment, coarser elsewhere.
    xs=np.concatenate([np.arange(-48,12,.075),np.arange(12,30,.025),np.arange(30,48.001,.075)])
    nx=len(xs);ny=151;tile=M['Gravel'].get('tile_metres',1.6)
    ys=np.linspace(-13.53,-9.825,ny)
    def sample(x,y):
        u=x/tile%1;v=y/tile%1
        return float(px[int(v*(im.size[1]-1)),int(u*(im.size[0]-1))])
    vs=[];fs=[]
    for i,x in enumerate(xs):
        for j,y in enumerate(ys):
            edge=min(1,(y+13.53)/.18,(-9.825-y)/.12)
            z=-.019+(sample(x,y)-.35)*.034*max(0,edge)
            vs.append((x,y,z))
            if i and j:
                k=i*ny+j;fs.append((k-ny-1,k-1,k,k-ny))
    mesh('Scanned gravel relief - editable geometry',vs,fs,'Gravel',0,True)
    # Irregular pea gravel silhouettes at the paved edge, embedded in the bed.
    vs=[];fs=[]
    for i in range(3800):
        x=random.uniform(-48,48);y=random.uniform(-13.52,-9.82)
        rx=random.uniform(.005,.013);ry=rx*random.uniform(.7,1.4);z=-.016
        k=len(vs);n=7;angle=random.uniform(0,math.tau)
        for h,sc in [(0,.85),(.008,1),(.016,.4)]:
            for j in range(n):
                a=angle+j*math.tau/n;r=random.uniform(.83,1.07)
                vs.append((x+rx*math.cos(a)*r*sc,y+ry*math.sin(a)*r*sc,z+h))
        for ring in range(2):
            for j in range(n):fs.append((k+ring*n+j,k+ring*n+(j+1)%n,k+(ring+1)*n+(j+1)%n,k+(ring+1)*n+j))
        fs.append(tuple(k+2*n+j for j in range(n)))
    mesh('Small embedded gravel silhouettes',vs,fs,'Gravel',0,True)

def edge_deposits():
    global COL,PARENT
    PARENT=bpy.data.objects['G01_Track_and_Runoff'];COL=PARENT.users_collection[0]
    h,w=256,1024;u,v=np.meshgrid(np.linspace(0,1,w),np.linspace(0,1,h))
    field=np.kron(RNG.random((16,64)),np.ones((16,16)))
    for _ in range(8):field=(field+np.roll(field,1,0)+np.roll(field,-1,0)+np.roll(field,1,1)+np.roll(field,-1,1))/5
    fine=RNG.random((h,w))
    edge=np.clip((1-v)*(.9+field*.5)-field*.26,0,1)**2
    alpha=edge*(.12+.27*field)*(.4+.6*fine)
    rgba=np.dstack([.22+field*.045,.215+field*.04,.187+field*.036,alpha])
    im=generated_map('Track_Edge_Embedded_Dust_RGBA',rgba)
    mat=pbr('EdgeDeposition',(.24,.23,.19),.95)
    tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=im;bs=principled_node(mat)
    mat.node_tree.links.new(tex.outputs['Color'],bs.inputs['Base Color']);mat.node_tree.links.new(tex.outputs['Alpha'],bs.inputs['Alpha'])
    mat.surface_render_method='DITHERED';mat.use_transparency_overlap=False
    for ya,yb,z in [(-7.03,-6.63,.0025),(-9.827,-9.43,.0018)]:
        vs=[];fs=[]
        for i,x in enumerate(np.linspace(-48,48,193)):
            vs.extend([(x,ya,z),(x,yb+.035*random.uniform(-1,1),z)])
            if i:fs.append((2*i-2,2*i,2*i+1,2*i-1))
        ob=mesh('Fine deposits at paved margin',vs,fs,mat)
        for poly in ob.data.polygons:
            for li in poly.loop_indices:
                vi=ob.data.loops[li].vertex_index;ob.data.uv_layers.active.data[li].uv=((vs[vi][0]+48)/4,vi%2)
        ob.visible_shadow=False

def selected_scanned_surfaces():
    refined=ACQUIRED/'refinement'
    portable_image_material('Asphalt',refined/'asphalt_track','asphalt_track',2.0,base_tint=(1.45,1.49,1.50),normal_strength=.8)
    portable_image_material('Grass',refined/'withered_grass','withered_grass',2.0,normal_strength=.85)
    sheet=portable_image_material('CorrugatedSheet',refined/'corrugated_iron_03','corrugated_iron_03',2.0,normal_strength=.85,metal=.75)
    if sheet:
        for ob in S.objects:
            if ob.type=='MESH' and ob.name.startswith('Insulated end wall cladding panel'):
                old=ob.data.materials[0];ratio=old.get('tile_metres',1)/2.0
                ob.data.materials[0]=sheet
                for uv in ob.data.uv_layers.active.data:uv.uv*=ratio
    # Thin blades carry a simple leaf shader; photographs belong on the ground surface.
    leaves=pbr('DryGrassBlades',(.25,.24,.125),.92)
    for ob in S.objects:
        if ob.name.startswith('Mown verge grass blades'):ob.data.materials[0]=leaves
    candidates=list(ACQUIRED.rglob('gravel_stones_disp_2k.*'))
    if candidates:replace_gravel_geometry(candidates[0])

acquired_details()
selected_scanned_surfaces()
paint_surface_refinement()
edge_deposits()
