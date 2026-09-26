"""Longwan circuit environment. Blender 4.5+, metres, Z up.
Original geometry and procedural surface authoring. External PBR files stay intact.
Run: blender -b -t 4 --python source/build_scene.py -- --draft
"""
import bpy, math, random, json, sys, shutil
from pathlib import Path
from mathutils import Vector
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
ACQUIRED = ROOT / 'sources' / 'pbr'
random.seed(73019)
RNG = np.random.default_rng(73019)
ARGS = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
DRAFT = '--draft' in ARGS
for folder in ['scene','models','materials','previews','review']:
    (ROOT/folder).mkdir(exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
S=bpy.context.scene
S.unit_settings.system='METRIC'; S.unit_settings.scale_length=1
M={}; ROOTS=[]; COL=None; PARENT=None

def image_file(path, noncolor=False):
    im=bpy.data.images.load(str(path), check_existing=True)
    if noncolor: im.colorspace_settings.name='Non-Color'
    return im

def generated_map(name, data, noncolor=False):
    data=np.asarray(data,dtype=np.float32)
    if data.ndim==2: data=np.repeat(data[:,:,None],3,axis=2)
    if data.shape[2]==3: data=np.concatenate([data,np.ones((*data.shape[:2],1),dtype=np.float32)],axis=2)
    h,w=data.shape[:2]
    im=bpy.data.images.new(name,width=w,height=h,alpha=True)
    if noncolor: im.colorspace_settings.name='Non-Color'
    im.pixels.foreach_set(np.clip(data,0,1).ravel())
    im.filepath_raw=str(ROOT/'materials'/f'{name}.png'); im.file_format='PNG'; im.save()
    return im

def principled_node(mat):
    return next((node for node in mat.node_tree.nodes if node.bl_idname == 'ShaderNodeBsdfPrincipled'), None)

def pbr(name,color,rough=.65,metal=0,tile=1,texture=None,normal_strength=.35):
    mat=bpy.data.materials.new(name); mat.use_nodes=True
    mat.diffuse_color=(*color,1); mat['tile_metres']=tile
    bs=principled_node(mat)
    bs.inputs['Base Color'].default_value=(*color,1)
    bs.inputs['Roughness'].default_value=rough; bs.inputs['Metallic'].default_value=metal
    mat['authored_base_color']=list(color); mat['authored_roughness']=rough; mat['authored_metallic']=metal
    def tex(im, label):
        n=mat.node_tree.nodes.new('ShaderNodeTexImage'); n.image=im; n.label=label
        return n
    if texture:
        folder,stem,res=texture
        for role in ['diff','nor_gl','arm']:
            src=folder/f'{stem}_{role}_{res}.jpg'
            target=ROOT/'materials'/src.name
            if not target.exists(): shutil.copy2(src,target)
            im=image_file(target,role!='diff')
            if role=='diff' and name=='Asphalt':
                # Art-directed neutral tarmac derivative; source scan remains intact.
                px=np.empty(len(im.pixels),dtype=np.float32);im.pixels.foreach_get(px)
                px=px.reshape((im.size[1],im.size[0],4))
                lum=px[:,:,:3].mean(axis=2)
                rgb=np.stack([lum*.69,lum*.73,lum*.75],axis=2)
                im=generated_map('Longwan_AsphaltNeutral_BaseColor',rgb)
            if role=='diff' and name=='Concrete':
                px=np.empty(len(im.pixels),dtype=np.float32);im.pixels.foreach_get(px)
                px=px.reshape((im.size[1],im.size[0],4))
                lum=px[:,:,:3].mean(axis=2)
                detail=(lum-np.mean(lum))*.30
                im=generated_map('Longwan_PrecastConcrete_BaseColor',np.stack([.43+detail,.45+detail,.44+detail],axis=2))
            node=tex(im,role)
            if role=='diff': mat.node_tree.links.new(node.outputs['Color'],bs.inputs['Base Color'])
            elif role=='nor_gl':
                nm=mat.node_tree.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value=normal_strength
                mat.node_tree.links.new(node.outputs['Color'],nm.inputs['Color']); mat.node_tree.links.new(nm.outputs['Normal'],bs.inputs['Normal'])
            else:
                sep=mat.node_tree.nodes.new('ShaderNodeSeparateColor')
                mat.node_tree.links.new(node.outputs['Color'],sep.inputs['Color'])
                mat.node_tree.links.new(sep.outputs['Green'],bs.inputs['Roughness'])
                mat.node_tree.links.new(sep.outputs['Blue'],bs.inputs['Metallic'])
    M[name]=mat
    return mat

def coated(name,color,rough,metal=0,scale=1,wear=.12):
    """Native numeric PBR authoring; reproducible seed, image nodes export to glTF."""
    mat=pbr(name,color,rough,metal,scale)
    n=512
    u,v=np.meshgrid(np.arange(n)/n,np.arange(n)/n)
    fine=RNG.random((n,n)); wav=np.zeros((n,n))
    height=.5+(fine-.5)*.0008
    scratch=np.zeros((n,n),dtype=bool)
    mult=1+(fine-.5)*min(wear,.08)
    base=np.stack([np.clip(c*mult,0,1) for c in color],axis=2)
    base[scratch]*=.60
    baseim=generated_map(name+'_BaseColor',base)
    roughim=generated_map(name+'_Roughness',np.clip(rough+(fine-.5)*.028,0,1),True)
    gy,gx=np.gradient(height)
    norm=np.stack([.5-gx*2,.5-gy*2,np.ones_like(gx)],axis=2)
    normalim=generated_map(name+'_NormalGL',norm,True)
    bs=principled_node(mat)
    for im,socket in [(baseim,'Base Color'),(roughim,'Roughness')]:
        tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=im
        mat.node_tree.links.new(tex.outputs['Color'],bs.inputs[socket])
    tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=normalim
    nm=mat.node_tree.nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.16
    mat.node_tree.links.new(tex.outputs['Color'],nm.inputs['Color']);mat.node_tree.links.new(nm.outputs['Normal'],bs.inputs['Normal'])
    return mat

def begin(name,loc=(0,0,0),description=''):
    global COL,PARENT
    COL=bpy.data.collections.new(name);S.collection.children.link(COL)
    PARENT=bpy.data.objects.new(name,None); COL.objects.link(PARENT)
    PARENT.location=loc;PARENT['asset_description']=description; PARENT['units']='metres'
    ROOTS.append(PARENT)
    return PARENT

def mesh(name,verts,faces,mat,bevel=0,smooth=False):
    me=bpy.data.meshes.new(name);me.from_pydata(verts,[],faces);me.update()
    ob=bpy.data.objects.new(name,me);COL.objects.link(ob);ob.parent=PARENT
    if isinstance(mat,str): mat=M[mat]
    me.materials.append(mat)
    uv=me.uv_layers.new(name='UV0_metres')
    tile=mat.get('tile_metres',1)
    for poly in me.polygons:
        axis=max(range(3),key=lambda i:abs(poly.normal[i]))
        axes=((1,2),(0,2),(0,1))[axis]
        for li in poly.loop_indices:
            co=me.vertices[me.loops[li].vertex_index].co
            uv.data[li].uv=(co[axes[0]]/tile,co[axes[1]]/tile)
        poly.use_smooth=smooth
    if bevel:
        mod=ob.modifiers.new('Manufactured edge radius','BEVEL');mod.width=bevel;mod.segments=2
        mod=ob.modifiers.new('Weighted corner normals','WEIGHTED_NORMAL');mod.keep_sharp=True;mod.weight=50
    return ob

def box(name,p,d,mat,bevel=.015):
    x,y,z=p;a,b,c=[v*.5 for v in d]
    vs=[(x+i*a,y+j*b,z+k*c) for i,j,k in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
    return mesh(name,vs,[(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)],mat,bevel)

def cyl(name,p,r,depth,mat,n=20,axis=(0,0,1),r2=None):
    rot=Vector((0,0,1)).rotation_difference(Vector(axis).normalized())
    r2=r if r2 is None else r2
    vs=[Vector(p)+rot@Vector((rr*math.cos(2*math.pi*i/n),rr*math.sin(2*math.pi*i/n),zz)) for zz,rr in [(-depth/2,r),(depth/2,r2)] for i in range(n)]
    fs=[tuple(reversed(range(n))),tuple(range(n,n*2))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return mesh(name,vs,fs,mat,.002,True)

def beam(name,a,b,r,mat,n=10):
    a,b=Vector(a),Vector(b)
    return cyl(name,(a+b)/2,r,(b-a).length,mat,n,b-a)

def tube(name,points,r,mat,n=8):
    points=[Vector(p) for p in points];vs=[];fs=[]
    for i,p in enumerate(points):
        v=points[min(i+1,len(points)-1)]-points[max(i-1,0)]
        rot=Vector((0,0,1)).rotation_difference(v.normalized())
        vs.extend([p+rot@Vector((r*math.cos(j*2*math.pi/n),r*math.sin(j*2*math.pi/n),0)) for j in range(n)])
    for i in range(len(points)-1):
        for j in range(n): fs.append((i*n+j,i*n+(j+1)%n,(i+1)*n+(j+1)%n,(i+1)*n+j))
    return mesh(name,vs,fs,mat,0,True)

def torus(name,p,major,minor,mat,axis=(0,0,1),n=32,m=8):
    rot=Vector((0,0,1)).rotation_difference(Vector(axis).normalized());vs=[]
    for i in range(n):
        a=i*2*math.pi/n
        for j in range(m):
            b=j*2*math.pi/m;rr=major+minor*math.cos(b)
            vs.append(Vector(p)+rot@Vector((rr*math.cos(a),rr*math.sin(a),minor*math.sin(b))))
    fs=[(i*m+j,((i+1)%n)*m+j,((i+1)%n)*m+(j+1)%m,i*m+(j+1)%m) for i in range(n) for j in range(m)]
    return mesh(name,vs,fs,mat,0,True)

def label(name,text,p,size,mat='White',rot=(math.pi/2,0,0),align='CENTER'):
    cu=bpy.data.curves.new(name,'FONT');cu.body=text;cu.size=size;cu.align_x=align;cu.extrude=.0008;cu.resolution_u=3
    font=Path('/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf')
    if font.exists():
        try: cu.font=bpy.data.fonts.load(str(font),check_existing=True)
        except: pass
    ob=bpy.data.objects.new(name,cu);COL.objects.link(ob);ob.parent=PARENT;ob.location=p;ob.rotation_euler=rot;cu.materials.append(M[mat]);return ob

def bolts_y(x,y,z,dx,dz):
    for xx in [-dx/2,dx/2]:
        for zz in [-dz/2,dz/2]: cyl('Hex anchor with washer',(x+xx,y,z+zz),.027,.014,'Galvanized',6,(0,1,0))

def frame(name,x,y,z,w,h,mat='Graphite',t=.055):
    box(name+' sill',(x,y,z-h/2),(w+t,t,t),mat,.005)
    box(name+' head',(x,y,z+h/2),(w+t,t,t),mat,.005)
    for a in [-1,1]:box(name+' jamb',(x+a*w/2,y,z),(t,t,h),mat,.005)

def make_materials():
    pbr('Concrete',(.43,.45,.44),.8,tile=1.3,texture=(ACQUIRED/'polyhaven/rough_concrete','rough_concrete','2k'),normal_strength=.12)
    pbr('Asphalt',(.16,.17,.17),.84,tile=2,texture=(ACQUIRED/'local-originals/asphalt','asphalt_01','1k'),normal_strength=.35)
    pbr('Gravel',(.4,.41,.39),.93,tile=1.6,texture=(ACQUIRED/'polyhaven/gravel_stones','gravel_stones','2k'),normal_strength=.55)
    pbr('Paving',(.48,.48,.46),.85,tile=2,texture=(ACQUIRED/'polyhaven/floor_pavement','floor_pavement','2k'),normal_strength=.3)
    for args in [('White',(.69,.72,.70),.55,0,1,.06),('Graphite',(.095,.12,.14),.48,.10,1,.06),('Galvanized',(.42,.47,.48),.44,.85,.4,.23),('Vermilion',(.61,.055,.032),.56,.05,1,.10),('PaintWhite',(.7,.73,.7),.85,0,1,.4),('GreenRunoff',(.07,.28,.23),.9,0,2,.18),('Rubber',(.022,.026,.028),.86,0,.5,.10),('Soil',(.15,.13,.095),.96,0,1,.4),('Grass',(.105,.17,.072),.94,0,2,.45),('Rust',(.19,.065,.025),.9,.25,.5,.5),('DarkConcrete',(.31,.33,.32),.88,0,2,.22),('AsphaltPatch',(.115,.127,.13),.94,0,2,.25)]: coated(*args)
    coated('KerbRed',(.48,.045,.025),.92,0,.75,.20)
    pbr('Glass',(.89,.95,.98),.075,0)
    principled_node(M['Glass']).inputs['Transmission Weight'].default_value=1.0
    principled_node(M['Glass']).inputs['IOR'].default_value=1.45
    pbr('Black',(.007,.012,.014),.65)
    pbr('GlowWarm',(.7,.78,.72),.4)
    bs=principled_node(M['GlowWarm']);bs.inputs['Emission Color'].default_value=(.75,.85,.8,1);bs.inputs['Emission Strength'].default_value=.8
    pbr('RedLens',(.45,.007,.002),.2,.12)
    pbr('GreenLens',(.014,.35,.09),.2,.12)
    # Exportable wear overlay. Native generated data, sparse downward weathering.
    n=512;u,v=np.meshgrid(np.arange(n)/n,np.arange(n)/n);noise=RNG.random((n,n))
    a=(np.sin(2*math.pi*u*17)+np.sin(2*math.pi*u*39+.8))*.25+.5
    alpha=np.clip((a-.36)*1.8,0,.5)*(1-v)**2*(.55+.45*noise)
    rgba=np.dstack([np.full((n,n),.16),np.full((n,n),.145),np.full((n,n),.12),alpha])
    im=generated_map('WeatherStreak_BaseColorAlpha',rgba)
    mat=pbr('WeatherStreak',(.16,.14,.12),.97,tile=1)
    tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=im
    bs=principled_node(mat)
    mat.node_tree.links.new(tex.outputs['Color'],bs.inputs['Base Color']);mat.node_tree.links.new(tex.outputs['Alpha'],bs.inputs['Alpha'])
    mat.surface_render_method='DITHERED';mat.use_transparency_overlap=False
    # Uneven, feathered tyre transfer. Broad translucent marks instead of black wires.
    u,v=np.meshgrid(np.linspace(0,1,256),np.linspace(0,1,1024))
    grain=RNG.random(u.shape)
    edge=np.clip(np.sin(math.pi*u),0,1)**.7
    ends=np.clip(np.minimum(v,1-v)*9,0,1)
    broken=np.clip(.56+.25*np.sin(v*57)+.17*np.sin(v*137+u*8),0,1)
    alpha=edge*ends*broken*(.45+.55*grain)*.21
    im=generated_map('RubberTransfer_BaseColorAlpha',np.dstack([np.full(u.shape,.018),np.full(u.shape,.022),np.full(u.shape,.023),alpha]))
    mat=pbr('RubberTransfer',(.018,.022,.023),.92)
    tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=im
    bs=principled_node(mat);mat.node_tree.links.new(tex.outputs['Color'],bs.inputs['Base Color']);mat.node_tree.links.new(tex.outputs['Alpha'],bs.inputs['Alpha'])
    mat.surface_render_method='DITHERED';mat.use_transparency_overlap=False

def grime(x,y,z,w,h):
    ob=mesh('Rain splash and wall foot weathering',[(x-w/2,y,z),(x+w/2,y,z),(x+w/2,y,z+h),(x-w/2,y,z+h)],[(0,1,2,3)],'WeatherStreak')
    for li,uv in enumerate([(0,0),(1,0),(1,1),(0,1)]):ob.data.uv_layers.active.data[li].uv=uv

def make_kerb_paint():
    """Chipped coating belongs on a concrete core, rather than replacing its body."""
    n=512;u,v=np.meshgrid(np.linspace(0,1,n),np.linspace(0,1,n))
    for variant in range(4):
        cloud=np.kron(RNG.random((32,32)),np.ones((16,16)))
        for _ in range(12):cloud=(cloud+np.roll(cloud,1,0)+np.roll(cloud,-1,0)+np.roll(cloud,1,1)+np.roll(cloud,-1,1))/5
        fine=RNG.random((n,n));edge=np.minimum.reduce([u,1-u,v*.7,(1-v)*.7])
        chip=(edge<.015)&(cloud>(.48+edge*6.0))
        chips=chip
        alpha=np.where(chips,0,1).astype(np.float32)
        for title,color in [('Red',(.43,.035,.018)),('White',(.62,.65,.61))]:
            name=f'Kerb_{title}_Worn_{variant}'
            detail=1+(fine-.5)*.05+(cloud-.5)*.10
            rgb=np.stack([c*detail for c in color],axis=2)
            im=generated_map(name+'_BaseColorAlpha',np.dstack([rgb,alpha]))
            mat=pbr(name,color,.94,0,tile=1)
            tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=im
            bs=principled_node(mat);mat.node_tree.links.new(tex.outputs['Color'],bs.inputs['Base Color']);mat.node_tree.links.new(tex.outputs['Alpha'],bs.inputs['Alpha'])
            mat.surface_render_method='DITHERED';mat.use_transparency_overlap=False

def rail_run(x0,x1,y,z,mat='Galvanized'):
    for h in [0,.37]:
        # Pressed W profile with folded upper/lower hems.
        yz=[(0,-.15),(-.055,-.12),(.025,-.075),(-.025,0),(.025,.075),(-.055,.12),(0,.15)]
        vs=[(x,y+dy,z+dz+h) for x in [x0,x1] for dy,dz in yz]
        fs=[(i,i+1,i+8,i+7) for i in range(6)]
        ob=mesh('W beam pressed steel crash rail',vs,fs,mat)
        mod=ob.modifiers.new('Steel sheet 3mm','SOLIDIFY');mod.thickness=.003
    for x in np.arange(x0+.3,x1,2.5):
        box('Galvanized post web',(x,y+.19,.64),(.07,.16,1.26),mat,.003)
        for yy in [y+.10,y+.27]:box('Post I flange',(x,yy,.64),(.15,.035,1.26),mat,.003)
        for zz in [z,z+.37]:bolts_y(x,y-.065,zz,.11,.06)

def fence_panel(x0,y,z,length=4,height=2.7,end_post=False):
    for x in ([x0,x0+length] if end_post else [x0]):
        foot=.045 if y<0 else z
        tube('Catch fence cranked stanchion',[(x,y,foot),(x,y,z+height),(x,y-.43,z+height+.64)],.042,'Galvanized')
        box('Post baseplate',(x,y,foot),(.28,.28,.035),'Galvanized',.004)
        if y<0:box('Independent catch fence footing',(x,y,-.014),(.42,.42,.10),'Concrete',.006)
        for xx in [-.10,.10]:
            for yy in [-.10,.10]:cyl('Fence base anchor',(x+xx,y+yy,foot+.025),.014,.023,'Galvanized',6)
        for zz in [z+.1,z+height*.5,z+height-.10]:
            box('Mesh fixing clamp',(x,y-.040,zz),(.14,.018,.045),'Galvanized',.003)
    # Fine welded grid authored as one mesh; readable profile without thousands of objects.
    vs=[];fs=[]
    def strip(a,b,w):
        a,b=Vector(a),Vector(b);side=Vector((0,1,0)).cross(b-a).normalized()*w/2
        k=len(vs);vs.extend([a-side,b-side,b+side,a+side]);fs.append((k,k+1,k+2,k+3))
    for x in np.arange(x0+.08,x0+length,.125):strip((x,y,z+.04),(x,y,z+height),.006)
    for h in np.arange(.10,height,.125):strip((x0,y,z+h),(x0+length,y,z+h),.006)
    mesh('Welded safety wire grid',vs,fs,'Graphite')
    for h in [.06,height]:beam('Fence tension cable',(x0,y,z+h),(x0+length,y,z+h),.011,'Galvanized',6)

def extinguisher(x,y,z=0):
    cyl('Extinguisher pressure vessel',(x,y,z+.40),.115,.54,'Vermilion',24,r2=.105)
    cyl('Extinguisher shoulder',(x,y,z+.68),.105,.10,'Vermilion',24,r2=.035)
    cyl('Extinguisher valve',(x,y,z+.76),.025,.08,'Galvanized',12)
    box('Extinguisher squeeze handle',(x,y,z+.82),(.18,.05,.025),'Graphite',.008)
    box('Extinguisher safety instruction label',(x,y-.115,z+.44),(.14,.008,.24),'White',.002)
    label('EXT label','FIRE',(x,y-.121,z+.46),.056,'Graphite')
    tube('Extinguisher discharge hose',[(x+.03,y,z+.78),(x+.17,y,z+.72),(x+.20,y,z+.40),(x+.18,y,z+.23)],.015,'Rubber')
    for zz in [.22,.56]:box('Extinguisher wall strap',(x,y+.04,z+zz),(.30,.05,.04),'Graphite',.004)

def hvac(x,y,z):
    box('HVAC roof equipment plinth',(x,y,z+.08),(2.35,1.5,.16),'Concrete',.015)
    box('HVAC coated sheet housing',(x,y,z+.65),(2.12,1.28,1.0),'White',.03)
    for xx in [x-.58,x+.58]:
        cyl('Condenser black recess',(xx,y,z+1.16),.40,.02,'Black',32)
        for r in [.12,.22,.32,.4]:torus('Fan concentric guard',(xx,y,z+1.18),r,.008,'Galvanized',n=32,m=4)
        for a in np.arange(0,math.pi,.393):beam('Fan radial guard',(xx-.4*math.cos(a),y-.4*math.sin(a),z+1.185),(xx+.4*math.cos(a),y+.4*math.sin(a),z+1.185),.007,'Galvanized',4)
        cyl('Fan motor hub',(xx,y,z+1.17),.075,.04,'Graphite',16)
    for zz in np.arange(z+.3,z+1.1,.085):box('HVAC ventilation louvre',(x,y-.655,zz),(1.90,.04,.025),'Galvanized',.002)
    tube('Insulated HVAC pipe',[(x+1,y,z+.3),(x+1.6,y,z+.3),(x+1.6,y,z-.3)],.055,'Rubber')

def service_door(x,y,z=0):
    box('Service door leaf',(x,y,z+1.12),(1.02,.07,2.16),'Graphite',.01)
    frame('Steel door reveal',x,y-.035,z+1.12,1.10,2.24,'Galvanized',.065)
    box('Door vision panel',(x,y-.06,z+1.63),(.62,.03,.48),'Glass',.005)
    box('Door lever',(x+.33,y-.13,z+1.02),(.18,.07,.02),'Galvanized',.006)
    for zz in [.25,1.85]:cyl('Door hinge barrel',(x-.51,y-.03,z+zz),.023,.13,'Galvanized',12)
    label('Access only placard','STAFF ONLY',(x,y-.055,z+1.27),.082,'White')

def buildings():
    begin('A01_Pit_Garages',(-16,20,0),'Three 6m garage bays, interior shells, structural columns, mechanical shutters and balcony. Front -Y.')
    box('Reinforced concrete floor',(0,0,.15),(23,10.5,.3),'Concrete',.025)
    # Column grid and actual facade openings.
    for x in [-10.2,-3.4,3.4,10.2]:box('Cast concrete structural pier',(x,-4.9,2.15),(.48,.55,4.0),'Concrete',.022)
    for x in [-10.9,10.9]:box('Garage end wall return',(x,-4.9,2.15),(.85,.55,4.0),'Concrete',.022)
    box('Rear structural wall',(0,5,2.18),(22.7,.3,4.15),'Concrete',.02)
    for x in [-11.3,11.3]:box('Side structural wall',(x,0,2.18),(.3,10,4.15),'Concrete',.02)
    for x in [-6.8,0,6.8]:
        box('Garage bay lintel',(x,-4.90,3.82),(6.34,.55,.7),'Concrete',.02)
        box('Garage roller shutter housing',(x,-5.03,3.52),(5.94,.40,.38),'Graphite',.028)
        for dx in [-2.86,2.86]:box('Shutter guide channel',(x+dx,-5.0,1.9),(.095,.12,3.10),'Galvanized',.003)
        closed= x!=0
        z0=.33 if closed else 2.62
        for zz in np.arange(z0,3.40,.14):
            box('Interlocked shutter slat',(x,-4.88,zz),(5.62,.045,.13),'Graphite',.008)
        if closed:
            box('Shutter bottom seal',(x,-4.90,.33),(5.6,.075,.075),'Rubber',.01)
            for dx in [-1.95,1.95]:box('Recessed shutter pull',(x+dx,-4.94,.96),(.20,.018,.07),'Galvanized',.015)
        box('Garage number fascia',(x,-5.215,4.08),(6.24,.14,.52),'White',.008)
        label('Bay number',f'{int((x+6.8)/6.8)+1:02}',(x-2.25,-5.295,3.91),.42,'Graphite')
        label('Bay identity','LONGWAN  /  MOTORSPORT',(x+.30,-5.296,4.045),.15,'Graphite')
        box('Red identification notch',(x+2.69,-5.30,4.08),(.22,.012,.36),'Vermilion',.001)
        for xx in [x-2.8,x+2.8]:
            box('Door kick protection',(xx,-5.10,.73),(.18,.09,.82),'Galvanized',.007)
        box('Garage overhead LED fixture',(x,-1.6,3.65),(2.3,.22,.055),'Graphite',.008)
        box('Garage overhead diffuser',(x,-1.6,3.61),(2.15,.17,.012),'GlowWarm',.002)
    for x in [-3.4,3.4]:box('Interior bay partition',(x,1,1.93),(.18,7.85,3.22),'DarkConcrete',.01)
    # Slab, walkway and upper storey: deep, separately framed glass.
    box('Upper slab with projecting balcony',(0,-.4,4.45),(24,12.2,.32),'Concrete',.025)
    box('Balcony steel edge flashing',(0,-6.51,4.57),(24.05,.065,.17),'Graphite',.007)
    box('Upper rear wall',(0,4.83,6.04),(22.7,.27,2.90),'White',.016)
    for x in [-11.25,11.25]:box('Upper end panel',(x,.25,6.05),(.30,9.5,2.85),'White',.015)
    for x in np.arange(-10.8,11.0,1.8):
        box('Upper curtain wall insulated glass',(x,-4.25,6.10),(1.72,.04,2.32),'Glass',.008)
        frame('Curtain wall mullion',x,-4.30,6.10,1.80,2.40,'Graphite',.065)
        box('Spandrel insulated panel',(x,-4.27,4.91),(1.73,.1,.22),'Graphite',.006)
        box('Window rear blind',(x,-3.98,6.8),(1.7,.025,.66),'White',.002)
    for x in np.arange(-11.6,11.8,1.6):
        box('Balcony railing post',(x,-6.15,5.07),(.045,.045,1.08),'Graphite',.004)
        box('Railing base shoe',(x,-6.15,4.55),(.15,.13,.05),'Galvanized',.005)
    for z in [4.73,5.15,5.58]:beam('Balcony horizontal balustrade',(-11.7,-6.15,z),(11.7,-6.15,z),.023,'Graphite')
    # Horizontal roof planes and structural soffit.
    box('Cantilever roof slab',(0,0,7.68),(25.4,12.2,.22),'White',.02)
    box('Roof fascia shadow seam',(0,-6.17,7.70),(25.45,.13,.34),'Graphite',.008)
    box('Roof graphite upper skin',(0,0,7.83),(25.20,12.05,.07),'Graphite',.01)
    for x in np.arange(-12.3,12.5,.65):box('Roof standing seam',(x,0,7.89),(.025,12,.055),'Galvanized',.004)
    for x in [-10.3,-3.4,3.4,10.3]:
        box('Cantilever structural web',(x,-.3,7.40),(.075,11.8,.35),'Graphite',.005)
        for z in [7.24,7.56]:box('Cantilever beam flange',(x,-.3,z),(.30,11.8,.045),'Graphite',.005)
    for x in [-10.9,10.9]:
        tube('Rainwater pipe with offsets',[(x,5.1,7.8),(x,5.5,7.3),(x,5.5,.45),(x,5.7,.21)],.065,'Galvanized')
        for z in [1,3,5,7]:box('Pipe wall clamp',(x,5.46,z),(.21,.17,.035),'Graphite',.004)
    hvac(-6,2.3,7.88);hvac(5,2.3,7.88)
    for x in [-11,-4,3,10]:
        grime(x,-5.20,.28,.38,.72)
    # End utility access recessed away from garage bays.
    service_door(-8.9,4.82,.3)
    extinguisher(10,-5.3,.30)
    for x in [-8,0,8]:
        box('Rear precast joint',(x,5.17,2.2),(.012,.004,3.7),'Graphite',0)
    # Furnished central bay, visible in open shutter.
    box('Work bench',(0,3.9,1.05),(4.7,.9,.09),'Galvanized',.018)
    box('Bench storage cabinet',(0,4,.64),(4.5,.74,.76),'Graphite',.02)
    for x in [-1.5,-.5,.5,1.5]:
        box('Bench storage door',(x,3.60,.66),(.92,.025,.69),'White',.01)
        box('Cabinet handle',(x+.27,3.56,.82),(.10,.04,.025),'Graphite',.003)
    box('Workshop pegboard',(0,4.80,2.2),(4.5,.04,1.6),'Graphite',.008)
    for x in np.arange(-1.9,2.1,.28):
        beam('Hanging spanner',(x,4.72,1.92),(x,4.72,2.35),.016,'Galvanized',6)
    label('Service wall lettering','LONGWAN  /  ENGINEERING',(0,4.70,2.60),.22,'White')

def tower():
    begin('A02_Race_Control',(12.6,20.2,0),'12m control tower with wrap-around observation room, exterior access stair and services.')
    box('Tower foundation',(0,0,.18),(6.7,7,.36),'Concrete',.02)
    for z in [1.4,3.9,6.4]:
        box('Precast core',(0,0,z),(5.6,5.8,2.46),'Concrete',.03)
        for x in [-2,2]:
            for zz in [z-.75,z+.75]:cyl('Concrete form tie recess',(x,-2.911,zz),.045,.008,'DarkConcrete',16,(0,1,0))
        box('Core formwork horizontal reveal',(0,-2.92,z+1.24),(5.6,.01,.018),'Graphite',0)
    service_door(0,-2.96,.36)
    box('Control platform',(0,0,8),(8.6,8,.33),'Graphite',.025)
    box('Control room floor',(0,0,8.18),(7.9,7.4,.15),'White',.018)
    for x in np.arange(-3.3,3.6,1.32):
        for y in [-3.52,3.52]:
            box('Observation glass',(x,y,9.37),(1.26,.06,2.15),'Glass',.012)
            frame('Observation mullions',x,y-.03,9.37,1.32,2.25,'Graphite',.065)
    for x in [-3.96,3.96]:
        for y in [-2.65,-.88,.88,2.65]:
            if x>0 and y==-.88:continue
            box('Side observation glass',(x,y,9.37),(.04,1.67,2.15),'Glass',.012)
            box('Side curtain mullion',(x,y-.87,9.37),(.07,.07,2.25),'Graphite',.004)
    box('Control room access door',(3.99,-1.1,9.30),(.075,1.40,2.22),'Graphite',.008)
    box('Control door vision glass',(4.033,-1.1,9.57),(.015,1.16,1.45),'Glass',.004)
    box('Control access lever',(4.10,-.58,9.13),(.11,.20,.025),'Galvanized',.005)
    for y in [-1.84,-.38]:box('Access door outer jamb',(4.04,y,9.30),(.1,.045,2.30),'White',.004)
    for x in [-2.4,0,2.4]:
        box('Race timing console desktop',(x,-2.45,8.95),(1.95,.78,.055),'Graphite',.012)
        for dx in [-.80,.80]:box('Console table leg',(x+dx,-2.4,8.54),(.035,.55,.80),'Galvanized',.003)
        box('Timing monitor shell',(x,-2.57,9.32),(.66,.07,.38),'Graphite',.018)
        box('Timing monitor screen',(x,-2.612,9.32),(.59,.009,.32),'Black',.003)
        box('Operator chair seat',(x,-1.42,8.72),(.46,.45,.08),'Graphite',.03)
        box('Operator chair back',(x,-1.2,8.97),(.46,.09,.47),'Graphite',.025)
        cyl('Operator chair support',(x,-1.42,8.44),.025,.45,'Galvanized',12)
    box('Control roof',(0,0,10.72),(9.1,8.8,.25),'White',.02)
    box('Control roof red edge',(0,-4.45,10.73),(9.1,.075,.25),'Vermilion',.006)
    box('Control roof membrane',(0,0,10.90),(8.95,8.65,.09),'Graphite',.015)
    label('Tower title','RACE CONTROL',(0,-4.015,7.84),.37,'White')
    label('Tower identifier','01',(0,-2.945,5.02),1.70,'Graphite')
    label('Tower identity','LONGWAN',(0,-2.945,4.52),.38,'Graphite')
    box('Tower red vertical wayfinding',(2.65,-2.95,4.98),(.16,.04,4.8),'Vermilion',.004)
    grime(0,-2.965,.35,5.6,.74)
    # Radio mast with bracketed aerial.
    cyl('Tower radio mast',(2.2,1.7,12.1),.043,2.6,'Galvanized',12)
    for z in [11.3,12.2]:beam('Antenna crossbeam',(1.75,1.7,z),(2.65,1.7,z),.018,'Galvanized')
    cyl('Antenna whip',(1.75,1.7,12.0),.012,2.3,'Graphite',8)
    # Switchback stair, 170mm rise, 280mm tread; two flights per half-height.
    for flight in range(4):
        zbase=.35+flight*1.90;direction=1 if flight%2==0 else -1
        xbase=3.8 if flight%2==0 else 5.35
        ystart=-2.7 if direction==1 else .66
        for i in range(12):
            y=ystart+direction*i*.28;z=zbase+i*(1.90/12)
            box('Galvanized open stair tread',(xbase,y,z),(1.25,.30,.045),'Galvanized',.003)
        ya=ystart;yb=ystart+direction*3.15
        for x in [xbase-.61,xbase+.61]:
            beam('Stair stringer',(x,ya,zbase-.08),(x,yb,zbase+1.82),.065,'Graphite',8)
            beam('Stair handrail',(x,ya,zbase+1.05),(x,yb,zbase+2.95),.023,'Galvanized')
            for i in [0,4,8,11]:beam('Stair baluster',(x,ystart+direction*i*.28,zbase+i*1.9/12),(x,ystart+direction*i*.28,zbase+i*1.9/12+1.05),.017,'Galvanized')
        box('Stair half landing',(4.56,yb+direction*.57,zbase+1.90),(2.85,1.12,.085),'Galvanized',.008)
    box('Tower top access bridge',(4.4,-1.55,8.03),(2.9,2.0,.10),'Galvanized',.008)

def ground():
    begin('G01_Track_and_Runoff',(0,0,0),'96m track sample; 14m track width; metric tiled PBR asphalt, geometric paint and surface variation.')
    box('Continuous site earth foundation',(0,6,-.34),(112,76,.42),'Soil',.04)
    box('Continuous paddock asphalt',(-4,24,-.075),(96,20,.15),'Asphalt',0)
    box('Pit wall foundation shoulder',(0,7.60,-.05),(96,1.22,.10),'DarkConcrete',0)
    box('Main straight asphalt',(0,0,-.13),(96,14,.26),'Asphalt',0)
    box('Pitlane asphalt',(0,11.0,-.115),(96,6.1,.23),'Asphalt',0)
    box('Pit apron outer lip',(-15,13.695,.04),(32,.39,.08),'Concrete',.006)
    box('Pit working apron behind drain',(-15,15.435,.04),(32,2.13,.08),'Concrete',.006)
    box('Paddock utility paving',(-4,28,-.055),(64,9,.14),'Paving',0)
    for y in [-6.85,6.85]:box('Track continuous edge line',(0,y,.0007),(96,.12,.001),'PaintWhite',0)
    box('Pitlane red separator',(0,9.13,.0007),(96,.13,.001),'Vermilion',0)
    for x in [-32,-20,-8,4]:
        for y in [-3.6,2.2]:
            box('Grid box side',(x,y,.0007),(3.5,.07,.001),'PaintWhite',0)
            box('Grid box end',(x-1.74,y+.6,.0007),(.07,1.27,.001),'PaintWhite',0)
    # Continuous exit merge line visible at driving height.
    tube('Pit exit painted blend line',[(14,9.1,.009),(22,9.1,.009),(31,8.2,.009),(43,6.9,.009)],.055,'PaintWhite',4)
    for x in np.arange(-48,48,1.2):
        idx=round((x+48)/1.2)
        # Sloped kerb profile with drainage-facing back edge.
        vs=[(xx,yy,zz) for xx in [x,x+1.18] for yy,zz in [(-7.06,.012),(-7.8,.10),(-8.12,.08),(-8.12,-.035),(-7.06,-.035)]]
        fs=[(0,1,2,3,4),(9,8,7,6,5)]+[(i,(i+1)%5,(i+1)%5+5,i+5) for i in range(5)]
        mesh('Sloped modular concrete kerb core',vs,fs,'Concrete',.006)
        cap=[(xx,yy,zz) for xx in [x+.002,x+1.178] for yy,zz in [(-7.062,.0128),(-7.8,.1008),(-8.118,.0808)]]
        mat=f'Kerb_{"Red" if idx%2==0 else "White"}_Worn_{idx%4}'
        ob=mesh('Worn kerb surface coating',cap,[(0,3,4,1),(1,4,5,2)],mat)
        for poly in ob.data.polygons:
            for li in poly.loop_indices:
                vi=ob.data.loops[li].vertex_index
                uu=vi//3;vv=[0,.70,1][vi%3]
                ob.data.uv_layers.active.data[li].uv=(1-uu if idx%3==0 else uu,vv)
        ob.visible_shadow=False
    box('Painted runoff strip',(0,-8.96,-.017),(96,1.76,.034),'GreenRunoff',0)
    box('Shallow gravel bed',(0,-11.63,-.08),(96,3.58,.14),'Gravel',0)
    # Irregular surface transitions use a jagged soil band and real scattered stones.
    vs=[];fs=[]
    for i,x in enumerate(np.linspace(-48,48,193)):
        vs.extend([(x,-13.28+random.uniform(-.10,.08),-.025),(x,-13.90+random.uniform(-.22,.20),-.03)])
        if i:fs.append((i*2-2,i*2-1,i*2+1,i*2))
    mesh('Gravel to earth irregular shoulder',vs,fs,'Soil')
    box('Grass verge south',(0,-23,-.20),(112,18,.30),'Grass',0)
    box('North grass strip',(0,38,-.20),(112,13,.30),'Grass',0)
    # Service aprons and non-uniform repairs kept clear of racing line.
    for x,y,w,h in [(-18,10.0,3.7,1.25),(4,12.2,2.8,.9),(32,-5.7,5.1,.8),(-39,4.7,2.4,.5)]:
        box('Asphalt maintenance patch',(x,y,.004),(w,h,.009),'AsphaltPatch',.035)
    for x in [-24,-17,-10]:
        box('Pit work bay floor edge',(x,13.695,.0807),(5.8,.07,.001),'PaintWhite',0)
        for xx in [x-2.9,x+2.9]:box('Pit work bay side',(xx,15.20,.0807),(.07,1.4,.001),'PaintWhite',0)
    for j in range(5):
        center=random.uniform(-3.4,3);start=random.uniform(-31,18);end=min(46,start+random.uniform(8,24));bend=random.uniform(-.8,.9)
        for side in [-.73,.73]:
            vs=[];steps=42;width=random.uniform(.095,.125)
            for t in np.linspace(0,1,steps):
                x=start+(end-start)*t;yy=center+side+bend*math.sin(t*math.pi*.5)
                vs.extend([(x,yy-width,.0018),(x,yy+width,.0018)])
            ob=mesh('Feathered paired tyre transfer',vs,[(i*2,i*2+1,i*2+3,i*2+2) for i in range(steps-1)],'RubberTransfer')
            for poly in ob.data.polygons:
                for li in poly.loop_indices:
                    vi=ob.data.loops[li].vertex_index;ob.data.uv_layers.active.data[li].uv=(vi%2,(vi//2)/(steps-1))
            ob.visible_shadow=False
    # Gravel details combined in a single low-poly mesh.
    vs=[];fs=[]
    for i in range(4000):
        x=random.uniform(-48,48);y=random.uniform(-13.9,-10);rx=random.uniform(.012,.033);ry=random.uniform(.012,.033)
        h=random.uniform(.009,.029);angle=random.uniform(0,2*math.pi);k=len(vs);n=6
        radii=[random.uniform(.75,1.15) for _ in range(n)]
        for z,scale in [(-.018,.70),(-.004,1),(h,.48)]:
            for j in range(n):
                a=angle+j*2*math.pi/n;r=radii[j]
                vs.append((x+rx*r*math.cos(a)*scale,y+ry*r*math.sin(a)*scale,z+random.uniform(-.002,.002)))
        for ring in range(2):
            for j in range(n):fs.append((k+ring*n+j,k+ring*n+(j+1)%n,k+(ring+1)*n+(j+1)%n,k+(ring+1)*n+j))
        fs.append(tuple(k+2*n+j for j in range(n)))
    mesh('Scattered shoulder gravel',vs,fs,'Gravel')
    # Grass tufts on fringe, sparse and directional; excludes maintained track margins.
    vs=[];fs=[]
    for i in range(2900):
        x=random.uniform(-51,51);y=random.choice([random.uniform(-27,-14),random.uniform(33,43)]);z=-.04
        h=random.uniform(.055,.20)
        for a in [random.uniform(0,math.pi),random.uniform(0,math.pi)]:
            w=.016;k=len(vs);dx=math.cos(a)*w;dy=math.sin(a)*w
            vs.extend([(x-dx,y-dy,z),(x+dx,y+dy,z),(x+.04*math.sin(a),y+.05*math.cos(a),z+h)]);fs.append((k,k+1,k+2))
    mesh('Mown verge grass blades',vs,fs,'Grass')

def drainage():
    begin('G02_Drainage_Channel',(-30.5,14.13,-.0475),'Modular trench drain with visible supporting rim, recess, cross bars and dirt accumulation.')
    for x in np.arange(0,32,1):
        box('Drain concrete surround',(x,0,-.01),(.98,.48,.18),'DarkConcrete',.008)
        box('Drain dark throat',(x,0,.085),(.87,.33,.011),'Black',0)
        for y in [-.185,.185]:box('Galvanized grate frame',(x,y,.108),(.96,.026,.036),'Galvanized',.002)
        for xx in np.arange(x-.43,x+.45,.075):box('Load bearing grate bars',(xx,0,.11),(.025,.35,.035),'Galvanized',.002)
        for xx in [x-.43,x+.43]:cyl('Grate retaining screw',(xx,.16,.129),.012,.006,'Graphite',8)

def boundary():
    begin('B01_Pit_Wall',(0,0,0),'Precast pit partition with joints, anchor details and safety fence; terminates before pit exit.')
    for x in np.arange(-46,14,2.4):
        # Concrete wedge (wide footing and narrow upper rail).
        vs=[(xx,yy,zz) for xx in [x,x+2.38] for yy,zz in [(8.00,0),(8.72,0),(8.62,.35),(8.54,1.12),(8.19,1.12),(8.13,.35)]]
        fs=[tuple(reversed(range(6))),tuple(range(6,12))]+[(i,(i+1)%6,(i+1)%6+6,i+6) for i in range(6)]
        mesh('Precast pit barrier module',vs,fs,'Concrete',.014)
        box('Pit barrier top protective cap',(x+1.19,8.36,1.145),(2.39,.38,.065),'Graphite',.008)
        for xx in [x+.25,x+2.12]:cyl('Cast lifting anchor pocket',(xx,8.11,.53),.037,.012,'DarkConcrete',12,(0,1,0))
        if int((x+46)/2.4)%4==0:grime(x+1.1,7.99,.06,2.25,.26)
    for x in np.arange(-46,10,4):fence_panel(x,8.40,1.16,4,2.05,end_post=x==6)
    for x in [-38,-22,-6]:
        box('Pit wall identification panel',(x,7.96,.64),(5.0,.055,.48),'Graphite',.012)
        label('Circuit wordmark on barrier','LONGWAN  /  CIRCUIT',(x,7.925,.52),.26,'White')
    begin('B02_Armco_and_Catch_Fence',(0,0,0),'Pressed two-high guardrail with I posts and fine welded-wire catch fence.')
    rail_run(-48,48,-14.5,.48)
    for x in np.arange(-44,48,4):
        for z in [.48,.85]:
            yz=[(0,-.15),(-.055,-.12),(.025,-.075),(-.025,0),(.025,.075),(-.055,.12),(0,.15)]
            vs=[(xx,-14.505+dy,z+dz) for xx in [x-.11,x+.11] for dy,dz in yz]
            mesh('Lapped guardrail splice',vs,[(i,i+1,i+8,i+7) for i in range(6)],'Galvanized')
            for zz in [z-.077,z+.077]:bolts_y(x,-14.50,zz,.12,.0)
    for x in np.arange(-48,48,4):fence_panel(x,-14.22,1.02,4,2.7,end_post=x==44)

def marshal():
    begin('A03_Marshal_Post',(29,16.7,0),'Compact track marshal hut, 2.8m high, shaded windows, access door and signal equipment.')
    box('Marshal hut foot slab',(0,0,.12),(4.4,3.3,.24),'Concrete',.018)
    box('Marshal lower wall',(0,0,.72),(3.7,2.6,1.16),'White',.025)
    box('Marshal back wall',(0,1.23,1.60),(3.7,.14,2.1),'White',.02)
    for x in [-1.8,1.8]:box('Marshal corner frame',(x,0,1.58),(.10,2.6,2.52),'Graphite',.006)
    for x in [-1.2,0,1.2]:
        box('Marshal forward window',(x,-1.25,1.96),(1.10,.04,1.25),'Glass',.006)
        frame('Marshal glazing frame',x,-1.30,1.96,1.2,1.32,'Graphite',.052)
    box('Marshal flat roof',(0,-.10,2.75),(4.65,3.4,.17),'Graphite',.02)
    box('Marshal orange fascia',(0,-1.83,2.75),(4.65,.05,.18),'Vermilion',.005)
    label('Marshal post sign','MP 01',(0,-1.34,.72),.43,'Graphite')
    label('Marshal post service label','PIT EXIT',(0,-1.34,.45),.16,'Graphite')
    extinguisher(2.08,-.4,.22)
    # Exterior utility cabinet.
    box('Electrical cabinet',(2.45,.9,.95),(.63,.40,1.36),'Graphite',.025)
    frame('Cabinet lid seal',2.45,.68,.95,.53,1.20,'Galvanized',.015)
    bolts_y(2.45,.66,.95,.45,1.10)
    label('Cabinet voltage label','230 V',(2.45,.646,1.15),.10,'White')
    for z in np.arange(.52,.80,.045):box('Cabinet ventilation slot',(2.45,.65,z),(.36,.01,.012),'Black',0)
    grime(0,-1.32,.18,3.5,.38)

def signal(x,y):
    begin('F01_Pit_Exit_Signal',(x,y,0),'Grounded signal post, two weatherhood lenses, controller box and flexible wiring.')
    box('Signal concrete footing',(0,0,.13),(.68,.65,.26),'Concrete',.025)
    cyl('Signal galvanized post',(0,0,1.88),.065,3.5,'Galvanized',16)
    box('Signal base plate',(0,0,.29),(.30,.30,.025),'Graphite',.005)
    for xx in [-.11,.11]:
        for yy in [-.11,.11]:cyl('Signal anchor bolt',(xx,yy,.32),.020,.04,'Galvanized',6)
    box('Signal housing',(0,-.05,3.02),(.48,.22,1.18),'Graphite',.055)
    for z,mat in [(3.27,'RedLens'),(2.78,'GreenLens')]:
        cyl('Signal lens gasket',(0,-.18,z),.18,.04,'Rubber',32,(0,1,0))
        cyl('Prismatic signal lens',(0,-.21,z),.151,.025,mat,32,(0,1,0))
        # Half cylindrical weather hood, open lower half.
        vs=[]
        for yy in [-.18,-.48]:
            for a in np.linspace(0,math.pi,17):vs.append((.19*math.cos(a),yy,z+.19*math.sin(a)))
        mesh('Signal sun hood',vs,[(i,i+1,i+18,i+17) for i in range(16)],'Graphite')
    box('Signal speed sign',(0,-.08,1.84),(.74,.065,.73),'White',.014)
    label('Pit speed','60',(0,-.121,1.67),.47,'Graphite')
    label('Pit speed units','PIT LIMIT',(0,-.123,1.49),.115,'Graphite')
    box('Signal control box',(.11,.14,.93),(.32,.22,.45),'Graphite',.022)
    tube('Signal conduit',[(.12,.26,.98),(.17,.24,1.25),(.09,.08,2.75)],.020,'Rubber')

def props():
    begin('F02_Tool_Trolley',(-12,13.15,0),'Rolling mechanic cabinet, six drawers, locks, side handle and swivel castors.')
    box('Tool trolley main cabinet',(0,0,.57),(1.22,.61,.88),'Vermilion',.025)
    box('Tool trolley work surface',(0,0,1.04),(1.30,.66,.06),'Rubber',.015)
    for z in [.24,.38,.52,.66,.80,.93]:
        box('Tool drawer face',(0,-.315,z),(1.10,.025,.115),'Vermilion',.010)
        box('Drawer extruded pull',(0,-.35,z+.04),(.98,.05,.022),'Galvanized',.005)
    for x in [-.47,.47]:
        for y in [-.23,.23]:
            cyl('Rubber caster wheel',(x,y,.105),.105,.065,'Rubber',20,(0,1,0))
            cyl('Caster axle cap',(x,y-.038,.105),.03,.02,'Galvanized',12,(0,1,0))
            box('Caster fork',(x,y,.24),(.04,.10,.14),'Galvanized',.005)
    tube('Trolley tubular side handle',[(.63,.2,.89),(.78,.2,.89),(.78,-.2,.89),(.63,-.2,.89)],.020,'Galvanized')
    label('Trolley small brand','LW / 07',(-.34,-.333,.80),.055,'White')
    begin('F03_Tyre_Rack',(-23,12.75,.12),'Two-tier welded rack with eight tyre casings, steel joints and round sidewall profile.')
    for x in [-1.28,1.28]:
        for y in [-.38,.38]:box('Tyre rack steel upright',(x,y,.84),(.045,.045,1.68),'Graphite',.004)
    for z in [.20,.97,1.68]:
        for y in [-.235,.235]:box('Rack tyre support rail',(0,y,z),(2.60,.045,.045),'Graphite',.004)
        for x in [-1.28,1.28]:box('Rack end crossmember',(x,0,z),(.045,.80,.045),'Graphite',.004)
    for z in [.47,1.24]:
        for x in [-.93,-.31,.31,.93]:
            profile=[(-.14,.21),(-.155,.235),(-.15,.293),(-.125,.328),(-.08,.343),(.08,.343),(.125,.328),(.15,.293),(.155,.235),(.14,.21),(.11,.20),(-.11,.20)]
            vs=[(x+d,rr*math.cos(a),z+rr*math.sin(a)) for a in np.linspace(0,2*math.pi,49)[:-1] for d,rr in profile]
            n=len(profile);fs=[(i*n+j,((i+1)%48)*n+j,((i+1)%48)*n+(j+1)%n,i*n+(j+1)%n) for i in range(48) for j in range(n)]
            mesh('Slick tyre casing profiled carcass',vs,fs,'Rubber',0,True)
            for d in [-.145,.145]:
                torus('Tyre moulded sidewall bead',(x+d,0,z),.222,.008,'Rubber',axis=(1,0,0),n=40,m=6)
                torus('Tyre sidewall embossed ring',(x+d,0,z),.280,.003,'Rubber',axis=(1,0,0),n=40,m=4)
            for d in [-.05,.05]:torus('Slick surface mould line',(x+d,0,z),.343,.002,'Black',axis=(1,0,0),n=48,m=4)
    begin('F04_Service_Bollards',(0,0,0),'Powder coated protective bollards with worn footplates.')
    for x,y in [(-28,14.8),(-4.4,14.8),(9.0,16.3),(16.2,16.3),(27,14.9),(31,14.9)]:
        cyl('Protective steel bollard',(x,y,.53),.075,1.0,'Vermilion',20)
        cyl('Bollard reflective band',(x,y,.76),.077,.14,'White',20)
        box('Bollard anchor base',(x,y,.035),(.25,.25,.045),'Graphite',.004)
    begin('F05_Braking_Board',(35,-13.65,0),'Double-post track distance board with rear bracing and anchor bolts.')
    for x in [-.45,.45]:
        box('Sign post',(x,0,.85),(.06,.06,1.7),'Galvanized',.004)
        beam('Sign rear diagonal brace',(x,.02,1.4),(x,.65,.12),.025,'Galvanized')
    box('Distance board sign',(0,-.02,1.60),(1.45,.07,1.18),'White',.018)
    frame('Sign folded metal border',0,-.065,1.60,1.42,1.15,'Graphite',.025)
    label('Distance board number','100',(0,-.069,1.37),.73,'Graphite')
    bolts_y(0,-.08,1.60,1.25,.95)

def lighting_pole(x,y):
    begin(f'F06_Floodlight_{x}',(x,y,0),'Tapered mast with inspection hatch, mounting plate and four individual floodlights.')
    box('Mast concrete plinth',(0,0,.18),(1.1,1.1,.36),'Concrete',.02)
    cyl('Tapered lighting pole',(0,0,5.88),.15,11.4,'Galvanized',16,r2=.08)
    box('Mast inspection hatch',(0,-.151,1),(.15,.018,.44),'Graphite',.007)
    beam('Floodlight mounting crossarm',(-1.4,0,11.50),(1.4,0,11.50),.053,'Graphite')
    for x in [-1.05,-.35,.35,1.05]:
        box('Floodlight cast housing',(x,-.05,11.52),(.56,.27,.38),'Graphite',.022)
        box('Floodlight glass diffuser',(x,-.196,11.52),(.49,.019,.30),'GlowWarm',.008)
        for dx in [-.20,.20]:box('Floodlight housing latch',(x+dx,-.212,11.52),(.028,.019,.34),'Galvanized',.004)

def gantry():
    begin('F07_Timing_Gantry',(-37,0,0),'Track-spanning steel truss, 5.45m minimum clearance beneath lights, timing sign, five start-light pods.')
    for y in [-9.6,9.6]:
        box('Gantry reinforced footing',(0,y,.25),(1.3,1.3,.5),'Concrete',.025)
        for x in [-.32,.32]:beam('Gantry vertical lattice chord',(x,y,.3),(x,y,6.9),.065,'Galvanized')
        for z in np.arange(.5,6.6,.68):beam('Gantry tower diagonal',(-.32,y,z),(.32,y,z+.68),.026,'Galvanized')
    for x in [-.34,.34]:
        for z in [6.14,6.90]:beam('Gantry horizontal chord',(x,-9.6,z),(x,9.6,z),.057,'Galvanized')
        for y in np.arange(-9.6,9.5,1.2):beam('Gantry triangulation',(x,y,6.14),(x,y+1.2,6.90),.028,'Galvanized')
    # Plate faces approach direction -X; text rotated to match.
    box('Gantry timing fascia',(-.42,0,6.60),(.10,12.7,.80),'Graphite',.012)
    label('Gantry LONGWAN sign','LONGWAN  MOTORSPORT',(-.48,0,6.37),.49,'White',rot=(math.pi/2,0,-math.pi/2))
    for y in [-1.8,-.9,0,.9,1.8]:
        box('Start light pod',(-.48,y,5.78),(.23,.60,.63),'Graphite',.04)
        for yy in [-.14,.14]:cyl('Start light red lens',(-.62,y+yy,5.78),.105,.018,'RedLens',24,(1,0,0))

def seating():
    begin('A04_Trackside_Grandstand',(-11,-22.3,0),'Small six-row grandstand; cantilever roof, open steel bracing and access aisles.')
    for row in range(6):
        y=-row*.80;z=.30+row*.42
        box('Precast stand terrace',(0,y,z),(19.6,.80,.18),'Concrete',.012)
        for x in [-8.3,-6.8,-5.3,-3.8,-2.3,.7,2.2,3.7,5.2,6.7,8.2]:
            # Two folded shell surfaces form seat and back, with rounded edges.
            mat='Vermilion' if row in [0,5] else 'Graphite'
            box('Moulded stadium seat',(x,y,z+.28),(.47,.44,.07),mat,.032)
            box('Moulded stadium backrest',(x,y-.22,z+.50),(.48,.075,.39),mat,.035)
            beam('Seat pedestal',(x,y,z+.1),(x,y,z+.25),.035,'Galvanized')
        for x in [-10,10]:
            beam('Grandstand side baluster',(x,y,z),(x,y,z+1.10),.028,'Galvanized')
    for x in [-9.5,-4.7,0,4.7,9.5]:
        beam('Raked grandstand support',(x,.15,.18),(x,-4.1,2.4),.085,'Graphite')
        beam('Grandstand rear support column',(x,-4.15,0),(x,-4.15,6.2),.095,'Graphite')
        beam('Grandstand roof outrigger',(x,-4.15,6.10),(x,1.1,5.80),.10,'Graphite')
        beam('Roof diagonal tie',(x,-4.15,4.30),(x,-.8,5.91),.052,'Graphite')
    box('Grandstand roof',(0,-1.65,6.18),(21.0,6.4,.14),'White',.015)
    box('Grandstand graphite fascia',(0,1.56,6.15),(21.0,.08,.37),'Graphite',.008)
    label('Grandstand designation','LONGWAN  /  SECTOR 01',(0,1.61,6.03),.31,'White',rot=(math.pi/2,0,math.pi))
    for x in [-10,10]:beam('Grandstand side handrail',(x,0,1.40),(x,-4.0,3.50),.029,'Galvanized')
    # End stair aisle below terrace edge.
    for i in range(12):box('Grandstand access step',(-.8,-i*.4,.22+i*.21),(1.4,.40,.12),'Galvanized',.004)

def construction_refinement():
    begin('D01_Architectural_Detail',(-16,20,0),'Facade cladding, equipment fixings, signage and construction joints for the pit building.')
    # A different, purposeful construction system on the garage side elevation.
    for y in np.arange(-4.55,4.6,1.18):
        box('Insulated end wall cladding panel',(-11.47,y,2.14),(.035,1.145,3.56),'White',.005)
        for yy in [y-.48,y+.48]:
            box('Folded vertical panel rib',(-11.50,yy,2.14),(.035,.035,3.54),'White',.003)
        for z in [.56,3.65]:cyl('Cladding screw washer',(-11.524,y,z),.020,.008,'Galvanized',8,(1,0,0))
    box('Cladding base flashing',(-11.51,0,.39),(.09,10.0,.16),'Graphite',.006)
    box('Cladding head flashing',(-11.51,0,3.96),(.12,10.0,.10),'Graphite',.006)
    for x in [-10.2,-3.4,3.4,10.2]:
        box('Beam connection vertical plate',(x,-5.195,3.43),(.34,.026,.49),'Galvanized',.004)
        bolts_y(x,-5.219,3.43,.23,.35)
        box('Beam connection bearing angle',(x,-5.26,3.65),(.39,.18,.035),'Galvanized',.003)
    # Stand-off identity, with physical backing and spacers.
    box('Circuit identity sign backing',(-2.0,-6.28,7.70),(9.2,.10,.70),'Graphite',.008)
    label('Architectural wordmark','LONGWAN',(-3.1,-6.344,7.48),.60,'White')
    label('Architectural wordmark secondary','MOTORSPORT PARK',(1.13,-6.344,7.65),.18,'White')
    for x in [-6.1,2.1]:bolts_y(x,-6.343,7.70,.12,.42)
    # Front canopy lighting and conduit follow real beam positions.
    tube('Canopy lighting conduit',[(-10.4,-5.44,4.22),(10.4,-5.44,4.22)],.018,'Galvanized')
    for x in [-6.8,0,6.8]:
        box('Canopy LED mounting channel',(x,-5.7,4.245),(2.1,.12,.06),'Graphite',.006)
        box('Canopy LED lens',(x,-5.7,4.208),(1.98,.095,.013),'GlowWarm',.004)
        tube('Conduit fixture branch',[(x,-5.44,4.22),(x,-5.7,4.22)],.016,'Galvanized')
    # Safety instruction plates and brackets are asset details, not UI decoration.
    for x in [-3.4,3.4]:
        box('Workshop safety placard',(x,-5.202,1.56),(.30,.013,.40),'White',.004)
        label('Workshop safety heading','PPE',(x,-5.212,1.63),.095,'Vermilion')
        label('Workshop safety caption','REQUIRED',(x,-5.212,1.51),.046,'Graphite')
        for z in [1.41,1.72]:cyl('Placard screw',(x,-5.221,z),.011,.009,'Galvanized',8,(0,1,0))
    begin('D02_Control_Details',(12.6,20.2,0),'Service entry awning, stair landing anchors and protected door threshold.')
    box('Service entry rain canopy',(0,-3.43,2.88),(1.70,1.15,.085),'Graphite',.012)
    for x in [-.59,.59]:
        beam('Canopy triangular bracket',(x,-2.97,2.28),(x,-3.91,2.84),.020,'Galvanized')
        box('Canopy anchor plate',(x,-2.958,2.56),(.14,.025,.61),'Galvanized',.004)
        bolts_y(x,-2.98,2.56,.075,.43)
    box('Control entry threshold',(0,-3.16,.395),(1.40,.50,.07),'Galvanized',.008)
    for y in [-1.85,-.5]:
        box('Top landing anchorage plate',(3.99,y,7.99),(.035,.20,.36),'Galvanized',.004)
        for z in [7.87,8.1]:cyl('Landing wall fixing',(4.02,y,z),.023,.020,'Graphite',6,(1,0,0))

def cameras_and_light():
    global COL,PARENT
    begin('Presentation',description='Presentation cameras and lighting, excluded from individual asset exports.')
    world=bpy.data.worlds.new('Longwan clear afternoon');S.world=world;world.use_nodes=True
    nt=world.node_tree;nt.nodes.clear();out=nt.nodes.new('ShaderNodeOutputWorld');bg=nt.nodes.new('ShaderNodeBackground');bg.inputs['Strength'].default_value=.78
    env=nt.nodes.new('ShaderNodeTexEnvironment')
    src=ACQUIRED/'local-originals/sky/kloofendal_48d_partly_cloudy_puresky_2k.hdr'
    target=ROOT/'materials'/src.name
    if not target.exists():shutil.copy2(src,target)
    env.image=image_file(target);nt.links.new(env.outputs['Color'],bg.inputs['Color']);nt.links.new(bg.outputs[0],out.inputs[0])
    sun=bpy.data.lights.new('Afternoon sun','SUN');sun.energy=2.0;sun.angle=math.radians(3)
    ob=bpy.data.objects.new('Afternoon sun',sun);COL.objects.link(ob)
    ob.rotation_euler=Vector((30,40,-70)).to_track_quat('-Z','Y').to_euler()
    # Soft open-bay bounce, plausible daylight rather than emissive staging.
    light=bpy.data.lights.new('Open garage daylight bounce','AREA');light.energy=180;light.shape='RECTANGLE';light.size=4;light.size_y=2
    ob=bpy.data.objects.new('Open garage daylight bounce',light);COL.objects.link(ob);ob.location=(-16,16.2,3.5);ob.rotation_euler=(math.radians(45),0,0)
    cams=[('01_overall',(-65,-58,36),(-4,6,2.5),42),('02_driving',(-43,-1.8,1.45),(14,3,3.0),36),('03_reverse',(43,-23,13),(-6,13,3.6),44),('04_garage',(-31,10.5,3.1),(-15,19,3.2),40),('05_facilities',(-18,10.1,1.65),(-13.8,13.2,.75),48),('06_surface',(23,-10.7,1.15),(3,-8.4,.01),52),('07_control',(25,8,7.9),(12,20,7),52),('08_rear',(8,43,19),(-5,18,4),46)]
    cams.extend([('09_barrier_detail',(2.4,12.25,1.30),(5.6,14.9,.47),52),('10_wall_detail',(-27.2,12.4,2.05),(-26.13,14.91,1.79),52)])
    for name,pos,aim,lens in cams:
        ca=bpy.data.cameras.new(name);ca.lens=lens;ca.clip_end=500
        ob=bpy.data.objects.new(name,ca);COL.objects.link(ob);ob.location=pos;ob.rotation_euler=(Vector(aim)-Vector(pos)).to_track_quat('-Z','Y').to_euler()
    S.camera=bpy.data.objects['01_overall']
    S.render.engine='CYCLES';S.cycles.samples=24 if DRAFT else 64;S.cycles.use_denoising=True
    S.cycles.max_bounces=8;S.cycles.diffuse_bounces=3;S.cycles.glossy_bounces=3;S.cycles.transmission_bounces=6
    S.render.resolution_x=1200 if DRAFT else 1920;S.render.resolution_y=750 if DRAFT else 1200;S.render.resolution_percentage=100
    S.render.image_settings.file_format='PNG';S.render.film_transparent=False
    S.view_settings.view_transform='AgX';S.view_settings.look='AgX - Medium High Contrast';S.view_settings.exposure=.15
    S.render.threads_mode='FIXED';S.render.threads=3
    # Keep saved viewport light and responsive on the 16GB machine.
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type=='VIEW_3D':area.spaces.active.shading.type='MATERIAL'

def inventory():
    records=[]
    deps=bpy.context.evaluated_depsgraph_get()
    for root in ROOTS:
        obs=[o for o in root.children_recursive if o.type in {'MESH','FONT','CURVE'}]
        triangles=0
        for o in obs:
            ev=o.evaluated_get(deps);me=ev.to_mesh();me.calc_loop_triangles();triangles+=len(me.loop_triangles);ev.to_mesh_clear()
        records.append({'asset':root.name,'description':root.get('asset_description',''),'location_m':list(root.location),'parts':len(obs),'triangles_evaluated':triangles})
    (ROOT/'review'/'scene-inventory.json').write_text(json.dumps({'blender':bpy.app.version_string,'asset_roots':records,'mesh_objects':sum(o.type=='MESH' for o in S.objects),'materials':[{'name':m.name,'tile_metres':m.get('tile_metres',1)} for m in M.values()]},indent=2),encoding='utf8')

make_materials();make_kerb_paint()
ground();drainage();buildings();tower();boundary();marshal();signal(23.2,10.0);props();lighting_pole(-31,-16);lighting_pole(30,30);gantry();seating();construction_refinement()
exec(compile((ROOT/'source'/'surface_refinement.py').read_text(),str(ROOT/'source'/'surface_refinement.py'),'exec'),globals())
cameras_and_light()
inventory()
S['project']='Longwan circuit independent environment asset collection'
S['game_integration']='NOT_RUN / independent art only'
S['revision']='r06'
for root in ROOTS:
    if root.name!='Presentation':
        collection=bpy.data.collections.get(root.name)
        collection.asset_mark();collection.asset_data.description=root.get('asset_description','')
bpy.ops.file.make_paths_relative()
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'scene'/'longwan_pit_exit_editable.blend'))
if '--no-render' not in ARGS:
    S.render.filepath=str(ROOT/'previews'/'r06_overall.png');bpy.ops.render.render(write_still=True)
print('LONGWAN_BUILD_COMPLETE')
