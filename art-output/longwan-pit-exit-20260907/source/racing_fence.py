"""Race-side debris fence, authored from structural forms visible in circuit reference.
Called in build_roadside.py's namespace; wire is geometry, not an alpha rectangle.
"""
def wire_bundle(name,segments,mat='Weathered galvanized steel',sides=6):
    vs=[];fs=[]
    for a,b,r in segments:
        a,b=Vector(a),Vector(b);q=Vector((0,0,1)).rotation_difference((b-a).normalized());k=len(vs)
        for p in [a,b]:vs.extend([p+q@Vector((r*math.cos(i*math.tau/sides),r*math.sin(i*math.tau/sides),0)) for i in range(sides)])
        fs += [tuple(k+i for i in reversed(range(sides))),tuple(k+sides+i for i in range(sides))]
        fs += [(k+i,k+(i+1)%sides,k+(i+1)%sides+sides,k+i+sides) for i in range(sides)]
    return mesh(name,vs,fs,mat,smooth=True)

def i_stanchion(name,a,b,width=.14,depth=.14,web=.007,flange=.010):
    a,b=Vector(a),Vector(b);up=(b-a).normalized();side=Vector((1,0,0));back=up.cross(side).normalized();w=width/2;d=depth/2;t=web/2
    shape=[(-w,-d),(w,-d),(w,-d+flange),(t,-d+flange),(t,d-flange),(w,d-flange),(w,d),(-w,d),(-w,d-flange),(-t,d-flange),(-t,-d+flange),(-w,-d+flange)]
    vs=[p+side*x+back*y for p in [a,b] for x,y in shape];n=len(shape)
    fs=[tuple(reversed(range(n))),tuple(range(n,n*2))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return mesh(name,vs,fs,'Weathered galvanized steel',.0018)

def racing_fence(x0=0,x1=24,y=6.45,height=3.85,bay=4):
    count=round((x1-x0)/bay);ys=y-.105;top_y=ys-.55;top_z=height+.55
    for i in range(count+1):
        x=x0+i*bay
        box('Race fence concrete footing',(x,y,-.181),(.48,.48,.36),'Concrete',.01)
        box('Race fence base plate',(x,y,.012),(.32,.30,.024),'Weathered galvanized steel',.003)
        i_stanchion('Race fence H stanchion',(x,y,.024),(x,y,height+.04))
        i_stanchion('Inward cranked upper stanchion',(x,y,height),(x,y-.55,top_z+.055))
        for dx in [-.112,.112]:
            for dy in [-.102,.102]:
                tube('M20 anchor washer',(x+dx,y+dy,.024),(x+dx,y+dy,.029),.025,'Fastener zinc',16)
                tube('M20 anchor nut',(x+dx,y+dy,.029),(x+dx,y+dy,.046),.017,'Fastener zinc',6)
                tube('Anchor threaded tail',(x+dx,y+dy,.045),(x+dx,y+dy,.056),.010,'Weathered galvanized steel',12)
        # Bolted gusset plates join the upright to its inward crank.
        for sign in [-1,1]:
            xx=x+sign*.074
            yz=[(y+.056,height-.21),(y+.057,height+.065),(y-.25,height+.30),(y-.29,height+.24)]
            vs=[(xx+dx,yy,zz) for dx in [-.004,.004] for yy,zz in yz]
            mesh('Crank joint gusset plate',vs,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)],'Weathered galvanized steel',.002)
            for yy,zz in [(y+.016,height-.09),(y-.07,height+.095),(y-.20,height+.22)]:
                tube('Crank gusset fixing',(xx,yy,zz),(xx+sign*.015,yy,zz),.012,'Fastener zinc',6)
        for z in [.17,1.52,2.75,height-.04]:
            box('Mesh rail standoff',(x,y-.078,z),(.16,.09,.065),'Weathered galvanized steel',.002)
            box('Mesh clamp plate',(x,ys-.013,z),(.205,.012,.055),'Weathered galvanized steel',.002)
            for dx in [-.074,.074]:tube('M8 mesh clamp bolt',(x+dx,ys-.020,z),(x+dx,ys-.030,z),.009,'Fastener zinc',6)
        box('Upper crank mesh saddle',(x,y-.585,top_z),(.19,.18,.055),'Weathered galvanized steel',.002)
        for dx in [-.071,.071]:tube('Upper saddle fixing',(x+dx,top_y-.011,top_z),(x+dx,top_y-.026,top_z),.009,'Fastener zinc',6)
    for i in range(count):
        xa=x0+i*bay+.055;xb=x0+(i+1)*bay-.055;segments=[]
        # 100 × 50 mm welded rectangular mesh, 5 mm wire diameter.
        for x in np.arange(xa,xb+.001,.10):
            segments.append(((x,ys,.12),(x,ys,height),.0025))
            segments.append(((x,ys,height),(x,top_y,top_z),.0025))
        for z in np.arange(.12,height+.001,.05):segments.append(((xa,ys-.004,z),(xb,ys-.004,z),.0025))
        for t in np.linspace(0,1,17):segments.append(((xa,ys-.55*t-.004,height+.55*t),(xb,ys-.55*t-.004,height+.55*t),.0025))
        wire_bundle('Geometric welded debris mesh '+str(i+1),segments)
        for z in [.15,1.52,2.75,height]:tube('Continuous mesh tension rail',(xa-.055,ys+.008,z),(xb+.055,ys+.008,z),.009,'Weathered galvanized steel',12)
        tube('Crank top tension rail',(xa-.055,top_y,top_z),(xb+.055,top_y,top_z),.012,'Weathered galvanized steel',12)
        for x in [xa,xb]:tube('Panel vertical lacing strip',(x,ys-.005,.12),(x,ys-.005,height),.006,'Weathered galvanized steel',8)
    for x in [x0,(x0+x1)/2,x1]:
        # Back stays anchor on the service side, outside the track-side face.
        box('Back stay concrete pad',(x,y+1.1,-.075),(.36,.42,.16),'Concrete',.006)
        tube('Fence back stay',(x,y+.065,2.62),(x,y+1.1,.06),.030,'Weathered galvanized steel',16)
        box('Back stay shoe',(x,y+1.1,.025),(.18,.20,.04),'Weathered galvanized steel',.003)
        for dx in [-.065,.065]:tube('Stay shoe anchor',(x+dx,y+1.1,.045),(x+dx,y+1.1,.073),.012,'Fastener zinc',6)
