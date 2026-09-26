"""24m reusable track-edge module, photographed ground PBR and geometric race-side debris fence.
Independent from the rejected prototype. Geometry remains editable and sources intact.
"""
import bpy, math, json, random
import numpy as np
from pathlib import Path
from mathutils import Vector,Matrix
R=Path(__file__).resolve().parents[1];D=R/'materials/roadside';KD=R/'materials/kerb-r03'
bpy.ops.wm.read_factory_settings(use_empty=True);S=bpy.context.scene
random.seed(4021);rng=np.random.default_rng(4021)
C=bpy.data.collections.new('Roadside_24m');S.collection.children.link(C)
ROOT=bpy.data.objects.new('Roadside_24m',None);C.objects.link(ROOT)
ROOT['description']='24m track edge: 14m road, kerb, paved shoulder, open drainage, gravel, pressed guardrail, curve-driven ribbed kerb and geometric cranked debris fence';ROOT['revision']='roadside-r03';ROOT['units']='metres'
MASTER=ROOT
def partroot(name):
    global ROOT
    ROOT=bpy.data.objects.new(name,None);C.objects.link(ROOT);ROOT.parent=MASTER
M={}
def bs(m):return next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
def plain(name,c,r=.6,metal=0):
    m=bpy.data.materials.new(name);m.use_nodes=True;b=bs(m);b.inputs['Base Color'].default_value=(*c,1);b.inputs['Roughness'].default_value=r;b.inputs['Metallic'].default_value=metal;m.diffuse_color=(*c,1);M[name]=m;return m
def im(path,linear=False):
    image=bpy.data.images.load(str(path),check_existing=True)
    if linear:image.colorspace_settings.name='Non-Color'
    return image
ao_group=bpy.data.node_groups.new('glTF Material Output','ShaderNodeTree');ao_group.interface.new_socket(name='Occlusion',in_out='INPUT',socket_type='NodeSocketFloat');ao_group.nodes.new('NodeGroupInput')
def pbr(name,colour,normal,rough,tile=2,metal=0,alpha=False,packed=True,strength=1):
    m=plain(name,(.3,.3,.3),.8,metal);m['tile_metres']=tile;b=bs(m);n=m.node_tree.nodes;l=m.node_tree.links
    t=n.new('ShaderNodeTexImage');t.image=im(colour);l.new(t.outputs['Color'],b.inputs['Base Color'])
    if alpha:l.new(t.outputs['Alpha'],b.inputs['Alpha']);m.surface_render_method='DITHERED'
    if normal:
        t=n.new('ShaderNodeTexImage');t.image=im(normal,True);q=n.new('ShaderNodeNormalMap');q.inputs['Strength'].default_value=strength;l.new(t.outputs['Color'],q.inputs['Color']);l.new(q.outputs['Normal'],b.inputs['Normal'])
    if rough:
        t=n.new('ShaderNodeTexImage');t.image=im(rough,True)
        if packed:
            sp=n.new('ShaderNodeSeparateColor');l.new(t.outputs['Color'],sp.inputs['Color']);l.new(sp.outputs['Green'],b.inputs['Roughness']);l.new(sp.outputs['Blue'],b.inputs['Metallic'])
            a=n.new('ShaderNodeGroup');a.node_tree=ao_group;l.new(sp.outputs['Red'],a.inputs['Occlusion'])
        else:l.new(t.outputs['Color'],b.inputs['Roughness'])
    return m
def ph(name,folder,stem,tile=2,strength=.7):
    d=R/'sources/pbr'/folder;return pbr(name,d/f'{stem}_diff_2k.jpg',d/f'{stem}_nor_gl_2k.jpg',d/f'{stem}_arm_2k.jpg',tile=tile,strength=strength)
ph('Track asphalt','refinement/asphalt_track','asphalt_track',2,.8)
ph('Concrete','polyhaven/rough_concrete','rough_concrete',1.23,.35)
ph('Gravel','polyhaven/gravel_stones','gravel_stones',2,.9)
ph('Short dry grass ground','refinement/withered_grass','withered_grass',2,.75)
pbr('Worn kerb coating',KD/'kerb_coating_base.jpg',KD/'kerb_coating_normal.png',KD/'kerb_coating_arm.png',tile=1,strength=.65)
metal=R/'sources/pbr/ambientcg/Metal038'
pbr('Weathered galvanized steel',metal/'Metal038_2K-JPG_Color.jpg',metal/'Metal038_2K-JPG_NormalGL.jpg',metal/'Metal038_2K-JPG_Roughness.jpg',tile=1,metal=1,packed=False,strength=.3)
plain('Cast iron',(.055,.061,.057),.78,.7);plain('Joint seal',(.025,.024,.022),.94);plain('Drain silt',(.066,.055,.037),.96)
plain('Fastener zinc',(.43,.47,.47),.42,1)
pbr('Photographic dust fringe',D/'gravel_dust_fringe.png',None,None,1,alpha=True)
pbr('Rubber contact trace',D/'rubber_contact_band.png',None,None,1,alpha=True)
for name in ['Photographic dust fringe','Rubber contact trace']:bs(M[name]).inputs['Roughness'].default_value=.90

def mesh(name,vs,fs,mat,bevel=0,smooth=False,uvscale=None):
    me=bpy.data.meshes.new(name);me.from_pydata(vs,[],fs);me.update();me.materials.append(M[mat] if isinstance(mat,str) else mat)
    o=bpy.data.objects.new(name,me);C.objects.link(o);o.parent=ROOT
    uv=me.uv_layers.new(name='UVMap');tile=me.materials[0].get('tile_metres',1)
    for p in me.polygons:
        p.use_smooth=smooth;ax=max(range(3),key=lambda i:abs(p.normal[i]));a,b=[(1,2),(0,2),(0,1)][ax]
        for li in p.loop_indices:
            v=me.vertices[me.loops[li].vertex_index].co;uv.data[li].uv=(v[a]/tile,v[b]/tile) if uvscale is None else (v[a]/uvscale[0],v[b]/uvscale[1])
    if bevel:
        mod=o.modifiers.new('Manufactured edge radius','BEVEL');mod.width=bevel;mod.segments=2
        mod=o.modifiers.new('Weighted corner normals','WEIGHTED_NORMAL');mod.keep_sharp=True
    return o
def boxes(name,spec,mat,bevel=.003):
    vs=[];fs=[];corners=[(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]
    for p,d in spec:
        k=len(vs);vs.extend([(p[0]+a*d[0]/2,p[1]+b*d[1]/2,p[2]+c*d[2]/2) for a,b,c in corners]);fs.extend([tuple(k+i for i in f) for f in [(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)]])
    return mesh(name,vs,fs,mat,bevel)
def box(name,p,d,mat,bevel=.003):return boxes(name,[(p,d)],mat,bevel)
def tube(name,a,b,r,mat,n=12):
    a,b=Vector(a),Vector(b);q=Vector((0,0,1)).rotation_difference((b-a).normalized());vs=[]
    for p in [a,b]:vs += [p+q@Vector((r*math.cos(i*math.tau/n),r*math.sin(i*math.tau/n),0)) for i in range(n)]
    fs=[tuple(reversed(range(n))),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return mesh(name,vs,fs,mat)
def plane(name,x0,x1,y0,y1,z0,z1,mat,uvscale=None):
    return mesh(name,[(x0,y0,z0),(x1,y0,z0),(x1,y1,z1),(x0,y1,z1)],[(0,1,2,3)],mat,uvscale=uvscale)
def image_pixels(path):
    image=im(path,True);a=np.empty(len(image.pixels),np.float32);image.pixels.foreach_get(a);return a.reshape((image.size[1],image.size[0],4))[:,:,0]
gh=image_pixels(R/'sources/pbr/polyhaven/gravel_stones/gravel_stones_disp_2k.png');low,high=np.percentile(gh,[2,98]);gh=np.clip((gh-low)/(high-low),0,1)
def hsample(a,x,y,tile=2):
    h,w=a.shape;u=(np.asarray(x)/tile%1)*(w-1);v=(np.asarray(y)/tile%1)*(h-1);i=u.astype(int);j=v.astype(int);fu=u-i;fv=v-j
    return a[j,i]*(1-fu)*(1-fv)+a[j,(i+1)%w]*fu*(1-fv)+a[(j+1)%h,i]*(1-fu)*fv+a[(j+1)%h,(i+1)%w]*fu*fv
def boundary(x):return 5.22+.055*np.sin(np.asarray(x)*2.4)+.033*np.sin(np.asarray(x)*5.7)
# Continuous surface falls gently to the working drainage edge.
partroot('E01_Road_Surfaces_24m')
plane('14m race surface',0,24,-14,0,.12,0,'Track asphalt')
plane('Paved recovery strip',0,24,1,2.30,.035,-.008,'Track asphalt')
box('Concrete kerb foundation',(12,.5,-.045),(24,1,.09),'Concrete',.003)
for edge,z in [(0,.0018),(1,.0355)]:
    vs=[];fs=[]
    for i,x in enumerate(np.linspace(0,24,481)):
        width=.019+.0025*math.sin(x*8.7)+.0014*math.sin(x*21.9)
        ys=(-width,.001) if edge==0 else (1.001,1+width)
        vs.extend([(x,y,z) for y in ys])
        if i:fs.append((2*i-2,2*i,2*i+1,2*i-1))
    mesh('Flexible asphalt / concrete edge seal',vs,fs,'Joint seal')
partroot('E02_Painted_Kerbs_24m')
exec(compile((R/'source/curve_kerb.py').read_text(),str(R/'source/curve_kerb.py'),'exec'))
kerb,path=create_curve_kerb(C,ROOT,M['Worn kerb coating'],'Ribbed kerb | procedural',[(0,0,0),(24,0,0)],width=1,rise=.025,pitch=.5,seed=3,core=M['Concrete'])
# White track limit uses cement coating microdetail; thin enough to remain paint.
partroot('E03_Road_Markings_24m')
stripe=pbr('Track limit paint',D/'track_limit_base.jpg',R/'sources/pbr/refinement/asphalt_track/asphalt_track_nor_gl_2k.jpg',D/'track_limit_arm.png',tile=2,strength=.33)
plane('Painted track limit',0,24,-.27,-.12,.27*.12/14+.0005,.12*.12/14+.0005,'Track limit paint')
for offset,length,y in [(1.1,16.1,-1.8),(4.2,17.2,-2.12),(8.8,8.1,-4.4)]:
    o=plane('Faint longitudinal rubber contact',offset,offset+length,y,y+.24,-y*.12/14+.0007,-(y+.24)*.12/14+.0007,'Rubber contact trace')
    for p in o.data.polygons:
        for li in p.loop_indices:
            v=o.data.vertices[o.data.loops[li].vertex_index].co;o.data.uv_layers.active.data[li].uv=((v.x-offset)/length,(v.y-y)/.24)
    o.visible_shadow=False
# Open U-channel: grate is actual geometry over a visible recess, not a black decal.
partroot('E04_Drainage_24m')
box('Drain concrete trough bottom',(12,2.465,-.205),(24,.33,.055),'Concrete',.002)
for y in [2.315,2.615]:box('Drain channel wall',(12,y,-.105),(24,.03,.18),'Concrete',.002)
box('Accumulated channel silt',(12,2.465,-.168),(24,.26,.014),'Drain silt',0)
for k in range(24):
    spec=[((k+.5,y,-.016),(.986,.012,.025)) for y in [2.346,2.584]]
    spec += [((k+.035+i*.039,2.465,-.018),(.009,.25,.030)) for i in range(25)]
    spec += [((k+.5,2.465,-.031),(.986,.009,.018))]
    boxes('Cast grate with open slots',spec,'Cast iron',.0015)
    for x in [k+.04,k+.96]:tube('Recessed grate fixing',(x,2.465,-.01),(x,2.465,-.002),.009,'Fastener zinc',6)
# Scan displacement becomes editable geometric relief with matching metric UVs.
partroot('E05_Gravel_24m')
xs=np.linspace(0,24,801);vs=[];fs=[];ny=91
for i,x in enumerate(xs):
    ys=np.linspace(2.63,boundary(x),ny)
    for j,y in enumerate(ys):
        edge=min(1,(y-2.63)/.09,(boundary(x)-y)/.10);z=-.024+(float(hsample(gh,x,y))-.34)*.033*max(0,edge)
        vs.append((x,y,z))
        if i and j:
            k=i*ny+j;fs.append((k-ny-1,k-1,k,k-ny))
mesh('Photographic gravel bed with relief',vs,fs,'Gravel',smooth=True)
vs=[];fs=[]
for i in range(2200):
    x=random.uniform(.02,23.98);y=random.uniform(2.64,float(boundary(x))+.02);z=-.019+float(hsample(gh,x,y))*.015
    rx=random.uniform(.005,.016);ry=rx*random.uniform(.6,1.4);rz=rx*random.uniform(.4,.9);k=len(vs)
    vs += [(x-rx,y,z),(x,y-ry,z),(x+rx,y,z),(x,y+ry,z),(x-rx*.35,y,z+rz),(x+rx*.3,y+.1*ry,z+rz*.9)]
    fs += [tuple(k+j for j in f) for f in [(0,1,4),(1,2,5,4),(2,3,5),(3,0,4,5)]]
mesh('Embedded loose aggregate silhouettes',vs,fs,'Gravel',smooth=True)
o=plane('Photographic deposits at paved margin',0,24,2.10,2.305,-.005,-.006,'Photographic dust fringe')
for p in o.data.polygons:
    for li in p.loop_indices:
        v=o.data.vertices[o.data.loops[li].vertex_index].co;o.data.uv_layers.active.data[li].uv=(v.x/4,(2.305-v.y)/.205)
o.visible_shadow=False
# Contiguous, non-straight gravel/grass boundary and short grass silhouettes.
partroot('E06_Grass_Verge_24m')
vs=[];fs=[];ny=34
for i,x in enumerate(np.linspace(0,24,121)):
    for j,y in enumerate(np.linspace(boundary(x),12,ny)):
        z=-.031+.008*math.sin(x*1.2)*math.sin(y*2.4);vs.append((x,y,z))
        if i and j:
            k=i*ny+j;fs.append((k-ny-1,k-1,k,k-ny))
mesh('Mown dry grass verge',vs,fs,'Short dry grass ground',smooth=True)
blade_mats=[plain('Dry grass blade '+str(i),c,.91) for i,c in enumerate([(.26,.225,.127),(.34,.295,.18),(.19,.21,.11),(.42,.37,.24)])]
vs=[];fs=[];indices=[]
for j in range(2200):
    x=random.uniform(0,24);y=float(boundary(x))+random.uniform(-.025,2.25)
    for b in range(random.randint(4,8)):
        a=random.uniform(0,math.tau);height=random.uniform(.023,.078);width=random.uniform(.0017,.0038);lean=random.uniform(.005,.022);k=len(vs);dx,dy=math.cos(a),math.sin(a);z=-.029
        vs += [(x-dy*width,y+dx*width,z),(x+dy*width,y-dx*width,z),(x+dx*lean*.45-dy*width*.5,y+dy*lean*.45+dx*width*.5,z+height*.55),(x+dx*lean*.45+dy*width*.5,y+dy*lean*.45-dx*width*.5,z+height*.55),(x+dx*lean,y+dy*lean,z+height)]
        fs += [(k,k+1,k+3,k+2),(k+2,k+3,k+4)];index=random.randrange(4);indices += [index,index]
o=mesh('Short verge grass blades',vs,fs,blade_mats[0]);
for m in blade_mats[1:]:o.data.materials.append(m)
for p,i in zip(o.data.polygons,indices):p.material_index=i
# Guardrail has pressed sheet cross section, continuous hem, splice overlaps and I posts.
partroot('E07_Guardrail_24m')
yz=[(.015,-.155),(-.018,-.149),(-.06,-.111),(-.028,-.069),(.018,-.043),(.031,-.027),(.031,.027),(.018,.043),(-.028,.069),(-.06,.111),(-.018,.149),(.015,.155)]
def rail_piece(x0,x1,z,offset=0):
    vs=[(x,5.80+dy+offset,z+dz) for x in [x0,x1] for dy,dz in yz];n=len(yz);fs=[(j,j+n,j+n+1,j+1) for j in range(n-1)]
    o=mesh('Formed W-beam galvanized sheet',vs,fs,'Weathered galvanized steel',.0015)
    so=o.modifiers.new('Actual 3mm sheet thickness','SOLIDIFY');so.thickness=.003
    # UV v follows profile arc length, preserving zinc grain around the folds.
    dist=[0]
    for a,b in zip(yz,yz[1:]):dist.append(dist[-1]+math.dist(a,b))
    for p in o.data.polygons:
        for li in p.loop_indices:
            vi=o.data.loops[li].vertex_index;v=o.data.vertices[vi].co;o.data.uv_layers.active.data[li].uv=(v.x,dist[vi%n]+z)
for i in range(6):
    for z in [.52,.86]:rail_piece(i*4,min(24,(i+1)*4+.16),z, -.003 if i%2 else 0)
for x in np.arange(.32,24,2):
    box('Guardrail I-post web',(x,6.01,.06),(.008,.135,1.82),'Weathered galvanized steel',.001)
    for y in [5.94,6.08]:box('Guardrail I-post flange',(x,y,.06),(.125,.010,1.82),'Weathered galvanized steel',.001)
    for z in [.52,.86]:
        box('Rail spacer block',(x,5.895,z),(.13,.12,.15),'Weathered galvanized steel',.003)
        by=5.80+.031+(-.003 if int(x//4)%2 else 0)
        tube('Rail post washer',(x,by-.001,z),(x,by-.008,z),.024,'Fastener zinc',16)
        tube('Rail post bolt',(x,by-.008,z),(x,by-.021,z),.013,'Fastener zinc',6)
for x in [4,8,12,16,20]:
    for z in [.52,.86]:
        for dx in [.035,.115]:
            for dz in [-.092,.092]:
                by=5.80+float(np.interp(dz,[a[1] for a in yz],[a[0] for a in yz]))-.003
                j=next(j for j in range(len(yz)-1) if yz[j][1]<=dz<=yz[j+1][1])
                slope=(yz[j+1][0]-yz[j][0])/(yz[j+1][1]-yz[j][1]);normal=Vector((0,-1,slope)).normalized();p=Vector((x+dx,by,z+dz))
                tube('Overlap washer',p+normal*.001,p+normal*.008,.015,'Fastener zinc',12)
                tube('Overlap fixing',p+normal*.008,p+normal*.018,.010,'Fastener zinc',6)
# Race-side debris fence replaces the ordinary industrial chainlink selection.
partroot('E08_Racing_Debris_Fence_24m')
exec(compile((R/'source/racing_fence.py').read_text(),str(R/'source/racing_fence.py'),'exec'))
racing_fence()
# Minimal presentation surroundings are explicitly excluded from asset export.
P=bpy.data.collections.new('Presentation');S.collection.children.link(P)
oldC,oldROOT=C,ROOT;C=P;ROOT=None
plane('Presentation ground',-75,90,-35,65,-.20,-.20,'Short dry grass ground')
C,ROOT=oldC,oldROOT
world=bpy.data.worlds.new('Matching Longwan daylight');world.use_nodes=True;S.world=world;nt=world.node_tree;bg=next(n for n in nt.nodes if n.type=='BACKGROUND');bg.inputs['Strength'].default_value=.65
env=nt.nodes.new('ShaderNodeTexEnvironment');env.image=im(R/'sources/pbr/local-originals/sky/kloofendal_48d_partly_cloudy_puresky_2k.hdr');nt.links.new(env.outputs['Color'],bg.inputs['Color'])
sun=bpy.data.lights.new('Afternoon sun','SUN');sun.energy=1.7;sun.angle=math.radians(2);o=bpy.data.objects.new('Afternoon sun',sun);P.objects.link(o);o.rotation_euler=Vector((.5,.65,-1)).to_track_quat('-Z','Y').to_euler()
views=[('roadside_overview',(-6,-10,6.5),(10,2.4,.75),38),('roadside_surface',(.5,-1.15,.73),(6.7,1.45,.06),44),('roadside_boundary',(3.0,2.3,2.1),(10.2,6.28,2.15),45),('roadside_kerb_close',(1,2.2,.62),(3.5,.6,.04),48)]
for name,pos,aim,lens in views:
    camera=bpy.data.cameras.new(name);camera.lens=lens;camera.clip_end=220;o=bpy.data.objects.new(name,camera);P.objects.link(o);o.location=pos;o.rotation_euler=(Vector(aim)-o.location).to_track_quat('-Z','Y').to_euler()
S.render.engine='CYCLES';S.cycles.samples=32;S.cycles.use_denoising=True;S.cycles.max_bounces=8;S.cycles.transparent_max_bounces=16
S.render.threads_mode='FIXED';S.render.threads=3;S.render.resolution_x=1600;S.render.resolution_y=1000;S.render.resolution_percentage=100;S.render.image_settings.file_format='PNG';S.view_settings.view_transform='AgX';S.view_settings.look='AgX - Medium High Contrast';S.view_settings.exposure=.2
S.unit_settings.system='METRIC';S.unit_settings.scale_length=1;S['game_integration']='NOT_RUN';S['revision']='roadside-r03';S.camera=bpy.data.objects['roadside_overview']
C.asset_mark();C.asset_data.description=MASTER['description'];bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(R/'scene/longwan_roadside_editable.blend'))
for name,_,_,_ in views:
    S.camera=bpy.data.objects[name];S.render.filepath=str(R/'previews'/f'{name}.png');bpy.ops.render.render(write_still=True);print('ROADSIDE_VIEW_COMPLETE '+name,flush=True)
print('ROADSIDE_BUILD_COMPLETE',flush=True)
