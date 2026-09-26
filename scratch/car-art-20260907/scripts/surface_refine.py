"""Model-specific PBR repairs. Runs inside Blender; no source assets are modified."""
import bpy, math, re

MX5 = {'Material.002':'paint','Material.001':'plastic','Material.012':'decal',
       'Material.013':'metal','Material.010':'glass','Material.004':'glass',
       'Material.005':'plastic','Material.008':'glass','Material.009':'metal',
       'Material.015':'metal','Material.014':'rubber','Material.017':'plastic'}
LP = {'Body':'paint','Chrome':'metal','Disk':'disc','Feux_chrome':'metal','Jante':'darkmetal',
      'Miroir':'mirror','Pneu':'rubber','Vitre':'glass','Phare_vitre':'lens','Phare_optique':'lens',
      'Feux_glass':'lens','Interieur_glass':'glass','Metal_alu':'metal','Metal_noir':'darkmetal',
      'Interieur':'leather','Interieur_color':'leather','Siege_color':'leather','Siege_noir':'leather',
      'Interieur_sol':'fabric','Plastique_noir':'plastic','Partie_noir':'plastic','Dessous':'plastic',
      'Plastique_rouge':'plastic','Phare':'metal','Logo_color':'metal','Frein':'caliper'}

def role(name, car):
    n=name.lower()
    if car=='mx5': return MX5.get(name,'authored')
    if car=='lp700':
        if name in LP:return LP[name]
        if name.startswith(('Feux_','Phare_blanc')):return 'lamp_insert'
    if 'blackglass' in n or 'gps_screen' in n or 'gauges_screen' in n: return 'screen'
    if 'mirror' in n or n=='miroir':return 'mirror'
    if 'glass' in n or 'window' in n or 'windshield' in n or 'lens' in n:
        return 'lens' if any(x in n for x in ['headlight','lens','feux','emissive_rear']) else 'glass'
    if 'tyre' in n or 'tire' in n or n=='pneu':return 'rubber'
    if 'rubber' in n:return 'rubbertrim'
    if 'carbon' in n and not 'ceramic' in n:return 'carbon'
    if any(x in n for x in ['alcantara','fabric','carpet','seatbelt','belt_schroth','int_net','stitch']):return 'fabric'
    if 'leather' in n or 'int_seat' in n:return 'leather'
    if any(x in n for x in ['plastic','blackout','wheelhouse','occlusion']):return 'plastic'
    if 'caliper' in n or 'calliper' in n:return 'caliper'
    if 'brake' in n or 'ext_disc' in n or 'rotor_edge' in n:return 'disc'
    if 'rim' in n or 'wheels_chrome' in n:return 'darkmetal'
    if 'antichrome' in n:return 'darkmetal'
    if 'chrome' in n or 'steel' in n or 'exhaust' in n or 'wing_metal' in n or 'screw' in n or 'rivet' in n:return 'metal'
    if 'carpaint' in n or n.startswith('paint___') or n.endswith('_paint') or '2024paint_material' in n:return 'paint'
    if 'headlight_reflector' in n or 'lighthouse' in n or 'headlight_high' in n:return 'metal'
    if 'taillight' in n or 'brakelight' in n or 'emissive_light' in n:return 'lamp_insert'
    if 'paint_matteblack' in n:return 'plastic'
    return 'authored'

def set_input(bs,key,value,disconnect=True):
    if key not in bs.inputs:return
    sock=bs.inputs[key]
    if disconnect:
        for l in list(sock.links):bs.id_data.links.remove(l)
    sock.default_value=value

def refine_material(mat,car):
    if not mat.use_nodes:return None
    bs=next((n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
    if not bs:return None
    r=role(mat.name,car)
    before={k:list(bs.inputs[k].default_value) if k=='Base Color' else float(bs.inputs[k].default_value)
            for k in ['Base Color','Metallic','Roughness','Alpha','Transmission Weight','Coat Weight']}
    base=bs.inputs['Base Color']; mapped=base.is_linked
    # Keep authored colour, decals, normal/occlusion maps. Reconstruct surface response.
    if r=='paint':
        set_input(bs,'Metallic',.18 if car in ('m5g90','gt3rs') else .03)
        set_input(bs,'Roughness',.28)
        set_input(bs,'Coat Weight',1.0);set_input(bs,'Coat Roughness',.13)
        set_input(bs,'Specular IOR Level',.5)
    elif r in ('glass','lens'):
        set_input(bs,'Metallic',0);set_input(bs,'Roughness',.055 if r=='glass' else .065)
        set_input(bs,'Transmission Weight',.96);set_input(bs,'IOR',1.46 if r=='glass' else 1.49)
        set_input(bs,'Coat Weight',.0);set_input(bs,'Alpha',1)
        if not mapped:set_input(bs,'Base Color',(.72,.78,.79,1) if r=='glass' else (.92,.95,.96,1))
        mat.use_backface_culling=False
    elif r in ('rubber','rubbertrim','plastic','leather','fabric','carbon'):
        rough={'rubber':.77,'rubbertrim':.63,'plastic':.48,'leather':.53,'fabric':.87,'carbon':.39}[r]
        set_input(bs,'Metallic',0);set_input(bs,'Roughness',rough,disconnect=not bs.inputs['Roughness'].is_linked)
        set_input(bs,'Coat Weight',.45 if r=='carbon' else 0)
        set_input(bs,'Coat Roughness',.22)
        if r=='fabric':set_input(bs,'Sheen Weight',.18)
        if not mapped and max(base.default_value[:3])<.008:set_input(bs,'Base Color',(.012,.013,.014,1))
    elif r in ('metal','darkmetal','mirror','disc','caliper'):
        set_input(bs,'Metallic',.95 if r!='caliper' else .45)
        set_input(bs,'Roughness',{'metal':.23,'darkmetal':.28,'mirror':.055,'disc':.36,'caliper':.26}[r],disconnect=r in ('metal','darkmetal','mirror'))
        set_input(bs,'Coat Weight',.5 if r in ('darkmetal','caliper') else 0)
        set_input(bs,'Coat Roughness',.18)
        if not mapped and max(base.default_value[:3])<.04:
            v=.14 if r=='darkmetal' else .45;set_input(bs,'Base Color',(v,v,v,1))
        if r=='mirror' and not mapped:set_input(bs,'Base Color',(.8,.82,.83,1))
    elif r=='lamp_insert':
        set_input(bs,'Metallic',.05);set_input(bs,'Roughness',.22)
        set_input(bs,'Coat Weight',.65);set_input(bs,'Coat Roughness',.1)
    elif r=='screen':
        set_input(bs,'Metallic',0);set_input(bs,'Roughness',.18)
    mat['refinement_role']=r
    return {'material':mat.name,'role':r,'before':before,
            'after':{k:list(bs.inputs[k].default_value) if k=='Base Color' else float(bs.inputs[k].default_value) for k in before}}

def make_grain_tile(out_path):
    """Deterministic, subtle moulded-surface tangent normal tile, editable procedural source."""
    import numpy as np
    N=256;rng=np.random.default_rng(71024)
    h=rng.random((N,N)).astype(np.float32)
    for _ in range(3):h=(h+np.roll(h,1,0)+np.roll(h,-1,0)+np.roll(h,1,1)+np.roll(h,-1,1))/5
    dx=(np.roll(h,-1,1)-np.roll(h,1,1))*.9;dy=(np.roll(h,-1,0)-np.roll(h,1,0))*.9
    pixels=np.ones((N,N,4),np.float32);pixels[:,:,0]=.5-dx;pixels[:,:,1]=.5-dy;pixels[:,:,2]=1
    im=bpy.data.images.new('SR_moulded_micrograin_normal',width=N,height=N,alpha=False)
    im.colorspace_settings.name='Non-Color';im.pixels.foreach_set(pixels.ravel());im.filepath_raw=str(out_path);im.file_format='PNG';im.save();im.pack()
    return im

def add_micrograin(mat,img):
    r=mat.get('refinement_role')
    if r not in ('rubber','rubbertrim','leather','plastic','fabric'):return False
    bs=next((n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
    if not bs or bs.inputs['Normal'].is_linked:return False
    nodes=mat.node_tree.nodes;links=mat.node_tree.links
    uv=nodes.new('ShaderNodeTexCoord');uv.location=(-850,-400)
    mp=nodes.new('ShaderNodeMapping');mp.location=(-650,-400);mp.inputs['Scale'].default_value=(24,24,24)
    tex=nodes.new('ShaderNodeTexImage');tex.image=img;tex.location=(-400,-400)
    nm=nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.25 if r=='rubber' else .15;nm.location=(-150,-350)
    links.new(uv.outputs['UV'],mp.inputs['Vector']);links.new(mp.outputs['Vector'],tex.inputs['Vector']);links.new(tex.outputs['Color'],nm.inputs['Color']);links.new(nm.outputs['Normal'],bs.inputs['Normal'])
    return True
