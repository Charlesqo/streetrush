"""Coordinate the remaining structures with the native masonry pit building."""
# The control room and equipment remain from the modeled prototype; replace its blank core.
control=bpy.data.objects.get('A02_Race_Control')
if control:
    control.location=(6.2,23,.14)
    remove=('Precast core','Concrete form tie','Core formwork','Service door','Steel door reveal','Door vision','Door lever','Door hinge','Access only','Tower red vertical','Tower identifier','Tower identity','Rain splash')
    for ob in list(control.children_recursive):
        if ob.name.startswith(remove):bpy.data.objects.remove(ob,do_unlink=True)
    C=control.users_collection[0];P=control
    for level in [.35,3.35,6.35]:
        final=level>6;height=1.6 if final else None
        for i in range(2):
            k='wall_standard_standard_01' if final else 'wall_door_centered_small_01' if level<1 and i==0 else 'wall_window_centered_large_01'
            native(k,(i*3,-3,level),height=height)
            if not final:native('door_centered_small_01' if k.startswith('wall_door') else 'window_centered_large_01',(i*3,-3,level))
            for pos,rot in [((-3+i*3,3,level),math.pi),((-3,-3+i*3,level),-math.pi/2),((3,3-i*3,level),math.pi/2)]:native('wall_standard_standard_01',pos,rot,height)
        if not final:
            for x,y,rot in [(-3,-3,0),(3,-3,math.pi/2),(3,3,math.pi),(-3,3,-math.pi/2)]:native('wall_pier_corner_01',(x,y,level),rot)
        for i in range(2):
            native('cornice01_standard_standard_01',(i*3,-3,level+min(3,height or 3)))
            native('cornice01_standard_standard_01',(-3+i*3,3,level+min(3,height or 3)),math.pi)
    box('Control title backing',(.7,-3.07,4.25),(2.20,.03,.45),'Graphite finish')
    label('Tower identifier','CONTROL 01',(.7,-3.091,4.12),.23)
    for x,y in [(-3.99,-3.52),(3.99,-3.52),(-3.99,3.52),(3.99,3.52)]:box('Observation corner post',(x,y,9.37),(.10,.10,2.24),'Graphite finish')
    # Complete the access bridge guard, leaving a real opening at the existing door.
    for y in [-2.55,-.55]:
        tube('Top landing guard',(4.15,y,9.12),(5.84,y,9.12),.023,'Zinc')
        for x in [4.22,5.7]:tube('Top landing baluster',(x,y,8.07),(x,y,9.12),.019,'Zinc')
    if 'D02_Control_Details' in bpy.data.objects:bpy.data.objects['D02_Control_Details'].location=control.location
# Replace the marshal kiosk's blank lower walls with a properly scaled native brick plinth.
marshal=bpy.data.objects.get('A03_Marshal_Post')
if marshal:
    marshal.location=(29.4,17.5,.17);C=marshal.users_collection[0];P=marshal
    for ob in list(marshal.children_recursive):
        if ob.name.startswith(('Marshal lower wall','Rain splash')):bpy.data.objects.remove(ob,do_unlink=True)
    # Full-width native brick piece, cropped without scaling its photographed brickwork.
    for pos,rot in [((1.5,-1.31,.24),0),((-1.5,1.31,.24),math.pi)]:native('wall_standard_standard_01',pos,rot,1.04)
    box('Marshal brick end infill',(-1.66,0,.74),(.3,2.62,1.0),'Region concrete')
    box('Marshal brick end infill',(1.66,0,.74),(.3,2.62,1.0),'Region concrete')
    glass=next(ob.data.materials[0] for ob in marshal.children_recursive if ob.name.startswith('Marshal forward window'))
    for x in [-1.81,1.81]:
        box('Marshal side observation glazing',(x,0,1.96),(.028,2.42,1.25),glass,.003)
        for y in [-1.23,0,1.23]:box('Marshal side window mullion',(x,y,1.96),(.063,.045,1.30),'Graphite finish')
        for z in [1.30,2.62]:box('Marshal side window rail',(x,0,z),(.063,2.5,.052),'Graphite finish')
    box('Marshal service door',(0,1.33,1.33),(.92,.06,2.14),'Graphite finish')
    tube('Marshal service lever',(.28,1.37,1.20),(.43,1.37,1.20),.012,'Zinc')
    label('Marshal rear door legend','STAFF',(0,1.374,1.73),.11,rot=(math.pi/2,0,math.pi))
# Reseat the grandstand at believable pitch/height and give the shell a continuous molded form.
stand=bpy.data.objects.get('A04_Trackside_Grandstand')
if stand:
    C=stand.users_collection[0];P=stand
    remove=('Moulded stadium','Seat pedestal','Grandstand roof','Grandstand graphite fascia','Grandstand designation','Raked grandstand support','Grandstand rear support column','Roof diagonal tie')
    for ob in list(stand.children_recursive):
        if ob.name.startswith(remove):bpy.data.objects.remove(ob,do_unlink=True)
    profile=[(.22,.52,.21),(.08,.475,.237),(-.10,.485,.24),(-.20,.55,.24),(-.255,.70,.235),(-.27,.91,.22),(-.255,1.00,.18)]
    vs=[];fs=[]
    for j,(y,z,w) in enumerate(profile):
        for i,u in enumerate(np.linspace(-1,1,11)):
            vs.append((u*w,y+.025*u*u,z-.025*(1-u*u)))
            if i and j:k=j*11+i;fs.append((k-12,k-1,k,k-11))
    proto=mesh('Moulded seat master',vs,fs,'Seat red',smooth=True)
    solid=proto.modifiers.new('Molded polypropylene wall','SOLIDIFY');solid.thickness=.008
    bevel=proto.modifiers.new('Molded rim','BEVEL');bevel.width=.005;bevel.segments=2
    red_mesh=proto.data;grey_mesh=red_mesh.copy();grey_mesh.materials.clear();grey_mesh.materials.append(M['Seat graphite'])
    positions=[-8.9+i*.55 for i in range(14)]+[.50+i*.55 for i in range(16)]
    for row in range(6):
        for j,x in enumerate(positions):
            ob=proto.copy();ob.data=grey_mesh if row==5 or j in [0,29] else red_mesh;C.objects.link(ob);ob.location=(x,-row*.80,.30+row*.42);ob.name='Moulded grandstand seat'
            tube('Seat pedestal',(x,-row*.80,.39+row*.42),(x,-row*.80,.75+row*.42),.027,'Zinc',8)
    bpy.data.objects.remove(proto,do_unlink=True)
    # I sections, diagonal struts and purlins support the cantilever roof.
    for x in [-9.5,-4.7,0,4.7,9.5]:
        box('Stand rear column web',(x,-4.15,3.05),(.012,.20,6.1),'Zinc')
        for y in [-4.25,-4.05]:box('Stand rear column flange',(x,y,3.05),(.20,.014,6.1),'Zinc')
        tube('Stand raked terrace support',(x,.2,.14),(x,-4.30,2.58),.085,'Graphite finish',8)
        tube('Roof main cantilever',(x,-4.15,6.18),(x,1.18,5.98),.115,'Graphite finish',8)
        tube('Roof compression strut',(x,-4.15,4.75),(x,-.1,6.025),.060,'Zinc',8)
        box('Stand column base plate',(x,-4.15,.04),(.42,.4,.045),'Zinc')
        for dx in [-.15,.15]:
            for dy in [-.14,.14]:tube('Stand anchor bolt',(x+dx,-4.15+dy,.06),(x+dx,-4.15+dy,.10),.016,'Zinc',6)
    for y in np.linspace(-4.8,1.2,7):tube('Roof longitudinal purlin',(-10.3,y,6.16-(y+4.8)*.04),(10.3,y,6.16-(y+4.8)*.04),.047,'Zinc',8)
    vs=[];fs=[]
    for i,x in enumerate(np.linspace(-10.5,10.5,421)):
        h=.012*math.cos(x*math.tau/.17)
        for y in [-5.05,1.4]:vs.append((x,y,6.22-(y+5.05)*.038+h))
        if i:fs.append((2*i-2,2*i,2*i+1,2*i-1))
    ob=mesh('Profiled stand metal roof',vs,fs,'Roof metal');so=ob.modifiers.new('Roof sheet','SOLIDIFY');so.thickness=.002
    box('Stand fascia',(0,1.41,5.93),(21.05,.06,.31),'Graphite finish')
    label('Stand designation','LONGWAN  /  CLUB STAND',(0,1.45,5.84),.25,rot=(math.pi/2,0,math.pi))
    for x in [-9.65,9.65]:
        tube('Stand rainwater downpipe',(x,-5.07,6.21),(x,-5.07,.12),.041,'Zinc',12)
    tube('Rear spectator safety top rail',(-9.7,-4.36,3.61),(9.7,-4.36,3.61),.028,'Zinc')
    for x in np.arange(-9.7,9.8,1.1):tube('Rear spectator safety post',(x,-4.36,2.44),(x,-4.36,3.61),.023,'Zinc')
# Roof services give the acquired pit building a functional roof without hiding its character.
begin('Pit_roof_services',(-31,18,.15))
for cx in [4,13]:
    box('AC isolated base',(cx,6.6,6.27),(1.65,1.10,.12),'Region concrete')
    box('AC powder coated cabinet',(cx,6.6,6.71),(1.45,.92,.77),'Warm white',.015)
    for z in np.arange(6.43,7.02,.075):box('AC condenser louver',(cx,6.123,z),(1.26,.025,.028),'Zinc',.001)
    for x in [cx-.53,cx+.53]:
        for z in [6.39,7.03]:tube('AC access fastener',(x,6.108,z),(x,6.096,z),.009,'Zinc',6)
    tube('AC insulated return',(cx+.72,6.7,6.54),(cx+1.18,6.7,6.54),.038,'Dark joints')
    tube('AC return roof penetration',(cx+1.18,6.7,6.54),(cx+1.18,6.7,6.2),.038,'Dark joints')
    box('AC service label',(cx+.42,6.093,6.85),(.22,.009,.17),'Warm white',.001)
    label('AC service ID','LW-AC',(cx+.42,6.086,6.84),.034,'Graphite finish')
for x in [1.5,6,10.5,16.5]:box('Roof access paver',(x,5.2,6.195),(.75,.6,.025),'Region concrete')
