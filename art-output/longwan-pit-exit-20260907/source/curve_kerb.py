"""Native Geometry Nodes kerb generator: editable path, real ribs, metric UVs.
No add-on and no Python rerun is needed for path/width/rib/seed edits in Blender.
"""
import bpy,math

def kerb_node_group():
    name='Longwan | Path-driven ribbed kerb'
    if name in bpy.data.node_groups:return bpy.data.node_groups[name]
    g=bpy.data.node_groups.new(name,'GeometryNodeTree');g.is_modifier=True
    def interface(name,typ,default=None,lo=None,hi=None,desc=''):
        s=g.interface.new_socket(name=name,in_out='INPUT',socket_type=typ)
        if default is not None:s.default_value=default
        if lo is not None:s.min_value=lo
        if hi is not None:s.max_value=hi
        s.description=desc;return s
    interface('Path','NodeSocketObject',desc='Edit this curve in Edit Mode. Generated kerb follows the evaluated curve.')
    interface('Width m','NodeSocketFloat',1,.25,2.5,'Physical kerb width; offset to the left of path direction.')
    interface('Use full path','NodeSocketBool',True,desc='Use the full curve, or use Length m to limit the generated section.')
    interface('Length m','NodeSocketFloat',24,.25,96,'Generated length, clamped to the available path; nominal area is length × width.')
    interface('Slope enabled','NodeSocketBool',True,desc='Turn off for a flat base; ribs have their own switch.')
    interface('Cross slope deg','NodeSocketFloat',4,0,15,'Transverse ramp angle. Zero produces a flat base.')
    interface('Ribs enabled','NodeSocketBool',True,desc='Turn longitudinal teeth on or off independently of the cross slope.')
    interface('Rib rise m','NodeSocketFloat',.025,0,.12,'Actual crest-to-trough addition at the outer edge.')
    interface('Rib pitch m','NodeSocketFloat',.5,.25,1.5,'Distance between physical ribs along the curve.')
    interface('Wear seed','NodeSocketFloat',0,0,100,'Continuous variation of existing wear texture sampling; geometry remains standardized.')
    interface('Surface','NodeSocketMaterial')
    interface('Concrete body','NodeSocketMaterial')
    g.interface.new_socket(name='Geometry',in_out='OUTPUT',socket_type='NodeSocketGeometry')
    n=g.nodes;l=g.links;inp=n.new('NodeGroupInput');out=n.new('NodeGroupOutput');inp.location=(-1100,300);out.location=(1250,250)
    def node(kind,label,x,y):
        a=n.new(kind);a.label=label;a.location=(x,y);return a
    def mathnode(op,a,b=None,label=''):
        q=n.new('ShaderNodeMath');q.operation=op;q.label=label or op
        for i,v in enumerate([a,b]):
            if v is None:continue
            if isinstance(v,(float,int)):q.inputs[i].default_value=v
            else:l.new(v,q.inputs[i])
        return q.outputs[0]
    info=node('GeometryNodeObjectInfo','Editable path',-900,450);info.transform_space='RELATIVE';l.new(inp.outputs['Path'],info.inputs['Object'])
    length=node('GeometryNodeCurveLength','Measured curve length',-650,450);l.new(info.outputs['Geometry'],length.inputs['Curve'])
    used=node('GeometryNodeSwitch','Full path or controlled length',-650,650);used.input_type='FLOAT';l.new(inp.outputs['Use full path'],used.inputs['Switch']);l.new(mathnode('MINIMUM',inp.outputs['Length m'],length.outputs['Length']),used.inputs['False']);l.new(length.outputs['Length'],used.inputs['True']);used_length=used.outputs[0]
    grid=node('GeometryNodeMeshGrid','Adaptive mesh along path',-450,450);grid.inputs['Size X'].default_value=1;grid.inputs['Size Y'].default_value=1;grid.inputs['Vertices Y'].default_value=13
    count=mathnode('ADD',mathnode('CEIL',mathnode('DIVIDE',used_length,.05)),1,'5cm longitudinal sampling')
    l.new(count,grid.inputs['Vertices X'])
    pos=n.new('GeometryNodeInputPosition');sep=n.new('ShaderNodeSeparateXYZ');l.new(pos.outputs[0],sep.inputs[0])
    u=mathnode('ADD',sep.outputs['X'],.5);v=mathnode('ADD',sep.outputs['Y'],.5)
    station=mathnode('MULTIPLY',u,used_length,'Physical station along path')
    sample=node('GeometryNodeSampleCurve','Sample exact path endpoints',-200,150);sample.mode='FACTOR';l.new(info.outputs['Geometry'],sample.inputs['Curves']);l.new(mathnode('DIVIDE',station,mathnode('MAXIMUM',length.outputs['Length'],.00001)),sample.inputs['Factor'])
    cross=n.new('ShaderNodeVectorMath');cross.operation='CROSS_PRODUCT';cross.inputs[0].default_value=(0,0,1);l.new(sample.outputs['Tangent'],cross.inputs[1])
    normalize=n.new('ShaderNodeVectorMath');normalize.operation='NORMALIZE';l.new(cross.outputs[0],normalize.inputs[0])
    width=mathnode('MULTIPLY',v,inp.outputs['Width m'])
    side=n.new('ShaderNodeVectorMath');side.operation='SCALE';l.new(normalize.outputs[0],side.inputs[0]);l.new(width,side.inputs['Scale'])
    xy=n.new('ShaderNodeVectorMath');xy.operation='ADD';l.new(sample.outputs['Position'],xy.inputs[0]);l.new(side.outputs[0],xy.inputs[1])
    phase=mathnode('FRACT',mathnode('DIVIDE',station,inp.outputs['Rib pitch m']))
    tooth=mathnode('MINIMUM',mathnode('DIVIDE',phase,.8),mathnode('DIVIDE',mathnode('SUBTRACT',1,phase),.2),'Long ramp / short fall')
    envelope=v  # Keep the track-side lip flush; the outer edge exposes the teeth.
    slope=mathnode('MULTIPLY',mathnode('TANGENT',mathnode('MULTIPLY',inp.outputs['Cross slope deg'],math.pi/180)),inp.outputs['Slope enabled'])
    base=mathnode('ADD',.003,mathnode('MULTIPLY',mathnode('MULTIPLY',v,inp.outputs['Width m']),slope))
    rise=mathnode('MULTIPLY',mathnode('MULTIPLY',mathnode('MULTIPLY',tooth,envelope),inp.outputs['Rib rise m']),inp.outputs['Ribs enabled'])
    height=mathnode('ADD',base,rise)
    z=n.new('ShaderNodeCombineXYZ');l.new(height,z.inputs['Z'])
    target=n.new('ShaderNodeVectorMath');target.operation='ADD';l.new(xy.outputs[0],target.inputs[0]);l.new(z.outputs[0],target.inputs[1])
    # Store the UV field before changing the grid's positions.
    uv=n.new('ShaderNodeCombineXYZ');l.new(mathnode('DIVIDE',station,4),uv.inputs['X'])
    drift=mathnode('ADD',mathnode('MULTIPLY',mathnode('SINE',mathnode('ADD',mathnode('MULTIPLY',station,.63),mathnode('MULTIPLY',inp.outputs['Wear seed'],7.13))),.19),mathnode('MULTIPLY',inp.outputs['Wear seed'],.317))
    l.new(mathnode('ADD',mathnode('DIVIDE',width,2),drift),uv.inputs['Y'])
    path_z=n.new('ShaderNodeSeparateXYZ');l.new(sample.outputs['Position'],path_z.inputs[0])
    keep_z=node('GeometryNodeStoreNamedAttribute','Local path elevation',100,450);keep_z.data_type='FLOAT';keep_z.domain='POINT';keep_z.inputs['Name'].default_value='KerbBaseZ';l.new(grid.outputs['Mesh'],keep_z.inputs['Geometry']);l.new(path_z.outputs['Z'],keep_z.inputs['Value'])
    store=node('GeometryNodeStoreNamedAttribute','Metric UVs and wear variation',350,450);store.data_type='FLOAT2';store.domain='CORNER';store.inputs['Name'].default_value='UVMap';l.new(keep_z.outputs[0],store.inputs['Geometry']);l.new(uv.outputs[0],store.inputs['Value'])
    deform=node('GeometryNodeSetPosition','Real ribbed surface',600,450);l.new(store.outputs['Geometry'],deform.inputs['Geometry']);l.new(target.outputs[0],deform.inputs['Position'])
    material=node('GeometryNodeSetMaterial','Coating PBR',900,450);l.new(deform.outputs['Geometry'],material.inputs['Geometry']);l.new(inp.outputs['Surface'],material.inputs['Material'])
    # Extrude vertically, flatten only the underside and close the original top.
    # A normal-direction Solidify would distort the underside at the steep ribs.
    extrude=node('GeometryNodeExtrudeMesh','Vertical concrete body',900,180);extrude.mode='FACES';extrude.inputs['Individual'].default_value=False;extrude.inputs['Offset Scale'].default_value=1;l.new(material.outputs[0],extrude.inputs['Mesh'])
    vertical=n.new('ShaderNodeCombineXYZ');vertical.inputs['Z'].default_value=-2.0;l.new(vertical.outputs[0],extrude.inputs['Offset'])
    elevation=n.new('GeometryNodeInputNamedAttribute');elevation.data_type='FLOAT';elevation.inputs['Name'].default_value='KerbBaseZ'
    under_pos=n.new('GeometryNodeInputPosition');under_sep=n.new('ShaderNodeSeparateXYZ');l.new(under_pos.outputs[0],under_sep.inputs[0]);under_vec=n.new('ShaderNodeCombineXYZ');l.new(under_sep.outputs['X'],under_vec.inputs['X']);l.new(under_sep.outputs['Y'],under_vec.inputs['Y']);l.new(mathnode('MAXIMUM',under_sep.outputs['Z'],mathnode('SUBTRACT',elevation.outputs['Attribute'],.08)),under_vec.inputs['Z'])
    flatten=node('GeometryNodeSetPosition','Flat cast underside',1150,180);l.new(extrude.outputs['Mesh'],flatten.inputs['Geometry']);l.new(under_vec.outputs[0],flatten.inputs['Position'])
    def vec(a,b):
        q=n.new('ShaderNodeCombineXYZ');l.new(a,q.inputs['X']);l.new(b,q.inputs['Y']);return q.outputs[0]
    body_norm=n.new('GeometryNodeInputNormal');body_norm_sep=n.new('ShaderNodeSeparateXYZ');l.new(body_norm.outputs[0],body_norm_sep.inputs[0])
    px=mathnode('DIVIDE',under_sep.outputs['X'],2);py=mathnode('DIVIDE',under_sep.outputs['Y'],2);pz=mathnode('DIVIDE',under_sep.outputs['Z'],2)
    side_uv=n.new('GeometryNodeSwitch');side_uv.input_type='VECTOR';l.new(mathnode('GREATER_THAN',mathnode('ABSOLUTE',body_norm_sep.outputs['X']),mathnode('ABSOLUTE',body_norm_sep.outputs['Y'])),side_uv.inputs['Switch']);l.new(vec(px,pz),side_uv.inputs['False']);l.new(vec(py,pz),side_uv.inputs['True'])
    body_uv=n.new('GeometryNodeSwitch');body_uv.input_type='VECTOR';l.new(mathnode('GREATER_THAN',mathnode('ABSOLUTE',body_norm_sep.outputs['Z']),.7),body_uv.inputs['Switch']);l.new(side_uv.outputs[0],body_uv.inputs['False']);l.new(vec(px,py),body_uv.inputs['True'])
    body_store=node('GeometryNodeStoreNamedAttribute','Metric body UVs, no stretched side pixels',1320,-120);body_store.data_type='FLOAT2';body_store.domain='CORNER';body_store.inputs['Name'].default_value='UVMap';l.new(flatten.outputs[0],body_store.inputs['Geometry']);l.new(body_uv.outputs[0],body_store.inputs['Value'])
    body_mat=node('GeometryNodeSetMaterial','Unpainted concrete sides and bottom',1350,180);l.new(body_store.outputs[0],body_mat.inputs['Geometry']);l.new(inp.outputs['Concrete body'],body_mat.inputs['Material'])
    flip=node('GeometryNodeFlipFaces','Outward body normals',1550,180);l.new(body_mat.outputs[0],flip.inputs['Mesh'])
    join=node('GeometryNodeJoinGeometry','Top and closed body',1750,450);l.new(material.outputs[0],join.inputs['Geometry']);l.new(flip.outputs[0],join.inputs['Geometry'])
    weld=node('GeometryNodeMergeByDistance','Weld shared rim',1950,450);weld.inputs['Distance'].default_value=.0001;l.new(join.outputs[0],weld.inputs['Geometry']);l.new(weld.outputs[0],out.inputs['Geometry']);out.location=(2150,450)
    # Keep mathematical fields grouped below the main generation chain for editing.
    hidden=[q for q in n if q.location.x==0 and q.location.y==0]
    for i,q in enumerate(hidden):q.location=(-1100+(i%8)*190,-50-(i//8)*210);q.hide=True
    return g

def create_curve_kerb(collection,parent,material,name,points,width=1,rise=.025,pitch=.5,seed=0,bezier=False,core=None,slope=4,slope_enabled=True,ribs_enabled=True,length=None):
    curve=bpy.data.curves.new(name+' Path','CURVE');curve.dimensions='3D';curve.resolution_u=32;curve.twist_mode='Z_UP'
    spline=curve.splines.new('BEZIER' if bezier else 'POLY')
    if bezier:
        spline.bezier_points.add(len(points)-1)
        for point,co in zip(spline.bezier_points,points):point.co=co;point.handle_left_type='AUTO';point.handle_right_type='AUTO'
    else:
        spline.points.add(len(points)-1)
        for point,co in zip(spline.points,points):point.co=(*co,1)
    path=bpy.data.objects.new(name+' | EDIT PATH',curve);collection.objects.link(path);path.parent=parent;path['export_helper']=True;path.hide_render=True
    me=bpy.data.meshes.new(name+' generated mesh');o=bpy.data.objects.new(name,me);collection.objects.link(o);o.parent=parent
    g=kerb_node_group();mod=o.modifiers.new('Path · Width · Ribs · Wear','NODES');mod.node_group=g
    values={'Path':path,'Width m':width,'Use full path':length is None,'Length m':length if length is not None else spline.calc_length(),'Slope enabled':slope_enabled,'Cross slope deg':slope,'Ribs enabled':ribs_enabled,'Rib rise m':rise,'Rib pitch m':pitch,'Wear seed':seed,'Surface':material,'Concrete body':core or material}
    for item in g.interface.items_tree:
        if item.item_type=='SOCKET' and item.in_out=='INPUT':mod[item.identifier]=values[item.name]
    bevel=o.modifiers.new('Small cast edge radius','BEVEL');bevel.width=.002;bevel.segments=2;bevel.limit_method='ANGLE'
    o['generator']='Native Geometry Nodes; edit path/parameters without running scripts';o['curve_edit_instructions']='Select EDIT PATH, Tab into Edit Mode, move Bezier control points. Width/Rib rise/Rib pitch/Wear seed live in the Geometry Nodes modifier.'
    return o,path
