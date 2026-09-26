"""Small modeling and portable PBR helpers for the independent 96m region."""
import bpy,math,random
import numpy as np
from mathutils import Vector,Matrix

def principal(mat):return next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
def begin(name,loc=(0,0,0)):
    global C,P
    C=bpy.data.collections.new(name);S.collection.children.link(C)
    P=bpy.data.objects.new(name,None);C.objects.link(P);P.parent=REGION;P.location=loc
    return P
def plain(name,color,rough=.6,metal=0):
    m=bpy.data.materials.new(name);m.use_nodes=True;b=principal(m);b.inputs['Base Color'].default_value=(*color,1);b.inputs['Roughness'].default_value=rough;b.inputs['Metallic'].default_value=metal;m.diffuse_color=(*color,1);M[name]=m;return m
def im(path,linear=False):
    a=bpy.data.images.load(str(path),check_existing=True)
    if linear:a.colorspace_settings.name='Non-Color'
    return a
def pbr(name,folder,stem,tile=2,strength=.5):
    m=plain(name,(.3,.3,.3));m['tile_metres']=tile;n=m.node_tree.nodes;l=m.node_tree.links;b=principal(m)
    for role in ['diff','nor_gl','arm']:
        t=n.new('ShaderNodeTexImage');t.image=im(folder/f'{stem}_{role}_2k.jpg',role!='diff')
        if role=='diff':l.new(t.outputs['Color'],b.inputs['Base Color'])
        elif role=='nor_gl':
            q=n.new('ShaderNodeNormalMap');q.inputs['Strength'].default_value=strength;l.new(t.outputs['Color'],q.inputs['Color']);l.new(q.outputs['Normal'],b.inputs['Normal'])
        else:
            q=n.new('ShaderNodeSeparateColor');l.new(t.outputs['Color'],q.inputs['Color']);l.new(q.outputs['Green'],b.inputs['Roughness']);l.new(q.outputs['Blue'],b.inputs['Metallic'])
            group=bpy.data.node_groups.get('glTF Material Output')
            if not group:
                group=bpy.data.node_groups.new('glTF Material Output','ShaderNodeTree');group.interface.new_socket(name='Occlusion',in_out='INPUT',socket_type='NodeSocketFloat');group.nodes.new('NodeGroupInput')
            a=n.new('ShaderNodeGroup');a.node_tree=group;l.new(q.outputs['Red'],a.inputs['Occlusion'])
    return m
def tinted(mat,name):
    m=mat.copy();m.name=name;n=m.node_tree.nodes;l=m.node_tree.links;b=principal(m)
    tex=b.inputs['Base Color'].links[0].from_socket
    attr=n.new('ShaderNodeVertexColor');attr.layer_name='RegionTint'
    mul=n.new('ShaderNodeMixRGB');mul.blend_type='MULTIPLY';mul.inputs[0].default_value=1;l.new(tex,mul.inputs[1]);l.new(attr.outputs['Color'],mul.inputs[2]);l.new(mul.outputs[0],b.inputs['Base Color'])
    M[name]=m;return m
def mesh(name,vs,fs,material,bevel=0,smooth=False,tint=None):
    me=bpy.data.meshes.new(name);me.from_pydata(vs,[],fs);me.update();me.materials.append(M[material] if isinstance(material,str) else material)
    o=bpy.data.objects.new(name,me);C.objects.link(o);o.parent=P
    uv=me.uv_layers.new(name='UVMap');tile=me.materials[0].get('tile_metres',1)
    for f in me.polygons:
        f.use_smooth=smooth;axis=max(range(3),key=lambda i:abs(f.normal[i]));axes=[(1,2),(0,2),(0,1)][axis]
        for li in f.loop_indices:
            v=me.vertices[me.loops[li].vertex_index].co;uv.data[li].uv=(v[axes[0]]/tile,v[axes[1]]/tile)
    if tint:
        a=me.color_attributes.new(name='RegionTint',type='FLOAT_COLOR',domain='CORNER')
        for f in me.polygons:
            for li in f.loop_indices:a.data[li].color=(*tint(me.vertices[me.loops[li].vertex_index].co),1)
    if bevel:
        mod=o.modifiers.new('Manufactured edge radius','BEVEL');mod.width=bevel;mod.segments=2
        mod=o.modifiers.new('Weighted normals','WEIGHTED_NORMAL');mod.keep_sharp=True
    return o
def box(name,p,d,mat,bevel=.004):
    vs=[(p[0]+x*d[0]/2,p[1]+y*d[1]/2,p[2]+z*d[2]/2) for x,y,z in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
    return mesh(name,vs,[(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)],mat,bevel)
def tube(name,a,b,r,mat,n=10):
    a,b=Vector(a),Vector(b);q=Vector((0,0,1)).rotation_difference((b-a).normalized());vs=[]
    for p in [a,b]:vs += [p+q@Vector((r*math.cos(i*math.tau/n),r*math.sin(i*math.tau/n),0)) for i in range(n)]
    fs=[tuple(reversed(range(n))),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return mesh(name,vs,fs,mat,smooth=True)
def label(name,body,p,size,mat='Warm white',rot=(math.pi/2,0,0)):
    cu=bpy.data.curves.new(name,'FONT');cu.body=body;cu.size=size;cu.align_x='CENTER';cu.extrude=.0006;cu.resolution_u=2
    font=Path('/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf')
    if font.exists():cu.font=bpy.data.fonts.load(str(font),check_existing=True)
    o=bpy.data.objects.new(name,cu);C.objects.link(o);o.parent=P;o.location=p;o.rotation_euler=rot;cu.materials.append(M[mat]);return o
def strip(name,xs,left,right,zleft,zright,mat,tint=None):
    vs=[];fs=[]
    for i,x in enumerate(xs):
        yl=left(x) if callable(left) else left;yr=right(x) if callable(right) else right
        zl=zleft(x) if callable(zleft) else zleft;zr=zright(x) if callable(zright) else zright
        vs.extend([(x,yl,zl),(x,yr,zr)])
        if i:fs.append((2*i-2,2*i,2*i+1,2*i-1))
    return mesh(name,vs,fs,mat,tint=tint)
def terrain(name,x0,x1,y0,y1,mat,step=.5,tint=None,zfun=None):
    xs=np.linspace(x0,x1,max(2,int((x1-x0)/step)+1));ys=np.linspace(y0,y1,max(2,int((y1-y0)/step)+1));vs=[];fs=[];ny=len(ys)
    for i,x in enumerate(xs):
        for j,y in enumerate(ys):
            vs.append((x,y,zfun(x,y) if zfun else 0))
            if i and j:k=i*ny+j;fs.append((k-ny-1,k-1,k,k-ny))
    return mesh(name,vs,fs,mat,smooth=True,tint=tint)
def load_collection(file,name):
    with bpy.data.libraries.load(str(file),link=False) as (src,dst):dst.collections=[name]
    col=dst.collections[0];assert col is not None,(file,name);return col
def load_native_templates():
    keys=['wall_standard_standard_01','wall_window_centered_large_01','window_centered_large_01','wall_door_centered_small_01','door_centered_small_01','wall_pier_corner_01','cornice01_standard_standard_01','crown_standard_standard_01']
    with bpy.data.libraries.load(str(R/'review/native_factory_inspection.blend'),link=False) as (src,dst):dst.objects=list(keys)
    temp=bpy.data.collections.new('Temporary native source parts');S.collection.children.link(temp)
    for o in dst.objects:temp.objects.link(o)
    bpy.context.view_layer.update();deps=bpy.context.evaluated_depsgraph_get();T={}
    for key,o in zip(keys,dst.objects):
        me=bpy.data.meshes.new_from_object(o.evaluated_get(deps),preserve_all_data_layers=True,depsgraph=deps);me.transform(Matrix.Translation(-o.matrix_world.translation)@o.matrix_world);T[key]=me
    for o in dst.objects:bpy.data.objects.remove(o,do_unlink=True)
    bpy.data.collections.remove(temp);return T
def native(key,pos,angle=0,height=None):
    me=T[key].copy()
    if height is not None:
        import bmesh
        bm=bmesh.new();bm.from_mesh(me)
        bmesh.ops.bisect_plane(bm,geom=list(bm.verts)+list(bm.edges)+list(bm.faces),plane_co=(0,0,height),plane_no=(0,0,1),clear_outer=True,clear_inner=False)
        bm.to_mesh(me);bm.free()
    ob=bpy.data.objects.new('Native masonry | '+key,me);C.objects.link(ob);ob.parent=P;ob.location=pos;ob.rotation_euler.z=angle;ob['source']='Poly Haven / James Ray Cock / CC0';return ob
