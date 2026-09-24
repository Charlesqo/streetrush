import * as THREE from 'three';

export function seededRandom(seed = 1049) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function smokeDensityTexture() {
  const size = 128, data = new Uint8Array(size * size * 4), random = seededRandom(93);
  const lobes = Array.from({ length: 16 }, () => ({ x:(random()-.5)*1.1, y:(random()-.5)*1.1, r:.17+random()*.36, a:.35+random()*.45 }));
  const hash=(x,y)=>{const v=Math.sin(x*127.1+y*311.7+93)*43758.5453;return v-Math.floor(v);};
  const noise=(x,y)=>{const ix=Math.floor(x),iy=Math.floor(y);let u=x-ix,v=y-iy;u=u*u*(3-2*u);v=v*v*(3-2*v);return THREE.MathUtils.lerp(THREE.MathUtils.lerp(hash(ix,iy),hash(ix+1,iy),u),THREE.MathUtils.lerp(hash(ix,iy+1),hash(ix+1,iy+1),u),v);};
  for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
    const px=(x+.5)/size*2-1, py=(y+.5)/size*2-1;
    let density=0;
    for (const l of lobes) density += Math.exp(-((px-l.x)**2+(py-l.y)**2)/(l.r*l.r))*l.a;
    const edge = Math.max(0,1-(px*px+py*py));
    const billow=noise(px*4+5,py*4+5)*.6+noise(px*9+13,py*9+13)*.28+noise(px*19+29,py*19+29)*.12;
    const d=Math.round(Math.min(1,density*.6)*edge*Math.pow(billow,1.3)*255);
    data.set([d,d,d,255],(y*size+x)*4);
  }
  const texture=new THREE.DataTexture(data,size,size);
  texture.magFilter=texture.minFilter=THREE.LinearFilter; texture.needsUpdate=true;
  return texture;
}

const smokeVertex = `attribute vec3 center, particleColor; attribute float diameter, alpha, angle;
  uniform mat4 sunMatrix; varying vec2 vUv; varying vec3 vColor, vWorld; varying float vAlpha, vDepth; varying vec4 vShadow;
  void main(){
    vec2 q=mat2(cos(angle),-sin(angle),sin(angle),cos(angle))*position.xy;
    vec4 c=modelViewMatrix*vec4(center,1.); c.xy+=q*diameter;
    vec4 world=modelMatrix*vec4(center,1.);
    // inverse view rotation puts the billboard offsets in world space.
    world.xyz+=vec3(viewMatrix[0][0],viewMatrix[1][0],viewMatrix[2][0])*q.x*diameter;
    world.xyz+=vec3(viewMatrix[0][1],viewMatrix[1][1],viewMatrix[2][1])*q.y*diameter;
    vWorld=world.xyz; vShadow=sunMatrix*world;
    vUv=uv; vColor=particleColor; vAlpha=alpha; vDepth=-c.z;
    gl_Position=projectionMatrix*c;
  }`;

const smokeFragment = `#include <packing>
  uniform sampler2D densityMap, sceneDepth, sunDepth;
  uniform vec2 viewport, shadowTexel;
  uniform vec3 sunDirection, sunColor, ambientColor, fogColor;
  uniform float cameraNear, cameraFar, shadowReady, lightEnabled, fogDensity;
  varying vec2 vUv; varying vec3 vColor, vWorld; varying float vAlpha, vDepth; varying vec4 vShadow;
  float sunlight(){
    if(shadowReady<.5) return 1.;
    vec3 p=vShadow.xyz/vShadow.w;
    if(p.x<0.||p.x>1.||p.y<0.||p.y>1.||p.z<0.||p.z>1.) return 1.;
    float result=0.;
    for(int x=0;x<2;x++)for(int y=0;y<2;y++){
      float depth=unpackRGBAToDepth(texture2D(sunDepth,p.xy+(vec2(float(x),float(y))-.5)*shadowTexel));
      result+=step(p.z-.00035,depth);
    }
    return result*.25;
  }
  void main(){
    float density=texture2D(densityMap,vUv).r;
    float z=-perspectiveDepthToViewZ(texture2D(sceneDepth,gl_FragCoord.xy/viewport).x,cameraNear,cameraFar);
    float opacity=density*vAlpha*smoothstep(0.,.42,z-vDepth)*smoothstep(.5,1.8,vDepth);
    if(opacity<.002) discard;
    vec2 q=vUv*2.-1.;
    vec3 normalView=normalize(vec3(q,sqrt(max(.02,1.-dot(q,q)))));
    vec3 normalWorld=vec3(dot(viewMatrix[0].xyz,normalView),dot(viewMatrix[1].xyz,normalView),dot(viewMatrix[2].xyz,normalView));
    float forwardScatter=pow(max(0.,-dot(normalize(cameraPosition-vWorld),sunDirection)),3.);
    vec3 irradiance=ambientColor+sunColor*sunlight()*(.22+.30*max(0.,dot(normalWorld,sunDirection))+.18*forwardScatter);
    vec3 rgb=vColor*mix(vec3(1.),irradiance,lightEnabled);
    float fog=1.-exp(-fogDensity*fogDensity*vDepth*vDepth);
    gl_FragColor=vec4(mix(rgb,fogColor,fog),opacity);
  }`;

export class TireEffects {
  constructor(scene, { groundRoot = null } = {}) {
    this.scene=scene; this.random=seededRandom(); this.demo=null; this.demoPaused=false; this.legacy=null; this.legacyActive=false;
    this.forcePreviewUntil=0; this.time=0; this.markCapacity=640; this.markCursor=0; this.markCount=0;
    this.lastMark=Array(4).fill(null); this.lastContact=Array(4).fill(null); this.spawnCredit=[0,0,0,0];
    this.surfaceCells=new Map();this.surfacePoint=new THREE.Vector3();
    // Road paint in this track is thin box geometry above the asphalt. Cache
    // those static surfaces once, so rubber follows paint without per-frame
    // scene raycasts or a floating plane raised above the entire road.
    if(groundRoot){
      groundRoot.updateMatrixWorld(true);
      const local=new THREE.Matrix4(),world=new THREE.Matrix4();
      groundRoot.traverse(o=>{
        if(!o.isMesh||o.geometry.type!=='BoxGeometry')return;
        const p=o.geometry.parameters,half=new THREE.Vector3(p.width/2,p.height/2,p.depth/2);
        for(let i=0;i<(o.isInstancedMesh?o.count:1);i++){
          if(o.isInstancedMesh)o.getMatrixAt(i,local);else local.identity();
          world.multiplyMatrices(o.matrixWorld,local);
          const e=world.elements,top=e[13]+Math.abs(e[5])*half.y;
          if(top<.015||top>.10||Math.abs(e[1])+Math.abs(e[9])>.001)continue;
          const bounds=new THREE.Box3(half.clone().negate(),half.clone()).applyMatrix4(world);
          const item={inverse:world.clone().invert(),half:half.clone(),top};
          for(let x=Math.floor(bounds.min.x/4);x<=Math.floor(bounds.max.x/4);x++)for(let z=Math.floor(bounds.min.z/4);z<=Math.floor(bounds.max.z/4);z++){
            const key=x+','+z;if(!this.surfaceCells.has(key))this.surfaceCells.set(key,[]);this.surfaceCells.get(key).push(item);
          }
        }
      });
    }
    this.markPositions=new Float32Array(this.markCapacity*18); this.markUvs=new Float32Array(this.markCapacity*12); this.markStrength=new Float32Array(this.markCapacity*6);
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(this.markPositions,3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('uv',new THREE.BufferAttribute(this.markUvs,2).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('strength',new THREE.BufferAttribute(this.markStrength,1).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0,0);
    this.marks=new THREE.Mesh(geometry,new THREE.ShaderMaterial({
      name:'rubber-on-shaded-asphalt', transparent:true, blending:THREE.MultiplyBlending, premultipliedAlpha:true, depthWrite:false,
      polygonOffset:true, polygonOffsetFactor:-1, polygonOffsetUnits:-1,
      vertexShader:'attribute float strength; varying vec2 vUv; varying float vStrength; void main(){vUv=uv;vStrength=strength;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:`varying vec2 vUv; varying float vStrength;
        void main(){float edge=smoothstep(0.,.12,vUv.x)*smoothstep(0.,.12,1.-vUv.x);
        float striation=.86+.09*sin(vUv.x*87.)+.05*sin(vUv.x*193.+sin(vUv.y*7.));
        float wear=.82+.18*sin(vUv.y*13.+sin(vUv.y*3.));
        float darken=clamp(vStrength*.47,0.,.55)*edge*striation*wear;
        gl_FragColor=vec4(vec3(1.-darken),1.);}`,
    }));
    // Multiply the already shaded road; its aggregate and sun shadow survive.
    // Draw before glass, never write depth or contribute a raised AO surface.
    this.marks.renderOrder=-20; this.marks.frustumCulled=false; scene.add(this.marks);
    this.particleCapacity=180; this.particleCursor=0;
    this.particles=Array.from({length:this.particleCapacity},()=>({life:0,maxLife:1,position:new THREE.Vector3(),velocity:new THREE.Vector3(),color:new THREE.Color(),angle:0,baseSize:1,viewDepth:0}));
    this.visibleParticles=[];
    this.smokeScene=new THREE.Scene();
    const plane=new THREE.PlaneGeometry(1,1), g=new THREE.InstancedBufferGeometry();
    g.index=plane.index; g.setAttribute('position',plane.attributes.position); g.setAttribute('uv',plane.attributes.uv);
    for(const [name,n] of [['center',3],['particleColor',3],['diameter',1],['alpha',1],['angle',1]]) g.setAttribute(name,new THREE.InstancedBufferAttribute(new Float32Array(this.particleCapacity*n),n).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount=0;
    this.smokeMaterial=new THREE.ShaderMaterial({
      name:'lit-soft-tire-smoke', transparent:true, depthWrite:false, depthTest:false,
      uniforms:{densityMap:{value:smokeDensityTexture()},sceneDepth:{value:null},sunDepth:{value:null},sunMatrix:{value:new THREE.Matrix4()},
        viewport:{value:new THREE.Vector2()},shadowTexel:{value:new THREE.Vector2()},sunDirection:{value:new THREE.Vector3()},sunColor:{value:new THREE.Color()},ambientColor:{value:new THREE.Color(.32,.38,.46)},
        fogColor:{value:new THREE.Color()},fogDensity:{value:0},cameraNear:{value:.1},cameraFar:{value:1300},shadowReady:{value:0},lightEnabled:{value:1}},
      vertexShader:smokeVertex,fragmentShader:smokeFragment,
    });
    this.smoke=new THREE.Mesh(g,this.smokeMaterial); this.smoke.frustumCulled=false; this.smokeScene.add(this.smoke);
    this.info={particles:0,screenCoverage:0,marks:0}; this.temp=new THREE.Vector3();
  }
  clear() {
    this.markCursor=this.markCount=this.particleCursor=0; this.marks.geometry.setDrawRange(0,0);
    this.lastMark.fill(null);this.lastContact.fill(null);this.spawnCredit.fill(0);
    for(const p of this.particles)p.life=0;
    if(this.legacy){this.legacy.dummy.position.set(0,-50,0);this.legacy.dummy.scale.setScalar(.001);this.legacy.dummy.updateMatrix();for(let i=0;i<this.legacy.markCapacity;i++)this.legacy.marks.setMatrixAt(i,this.legacy.dummy.matrix);this.legacy.marks.instanceMatrix.needsUpdate=true;for(const p of this.legacy.particles)p.life=0;}
  }
  setLegacy(instance) { this.legacy=instance; this.legacyActive=!!instance; this.clear(); }
  setDemo(mode, anchor) {
    this.clear();this.random=seededRandom();if(this.legacy)this.legacy.random=seededRandom();this.demoPaused=false;
    this.demo=mode?{mode,time:0,position:anchor.position.clone(),quaternion:anchor.quaternion.clone(),groundY:anchor.groundY??.02}:null;
  }
  demoTelemetry(dt) {
    const d=this.demo; d.time+=dt; if(d.time>8){this.clear();d.time=0;}
    const moving=d.mode==='marks'||d.mode==='both'; const emitting=d.time<4;
    const z=moving?-4+Math.min(d.time,4)*2:0;
    const x=moving?Math.sin(d.time*.65)*.6:0;
    const wheels=[-.7,.7].map(side=>{
      const p=new THREE.Vector3(x+side,0,z).applyQuaternion(d.quaternion).add(d.position);p.y=d.groundY;
      if(d.mode==='near')p.add(new THREE.Vector3(-1.5,0,2.1).applyQuaternion(d.quaternion));
      return {grounded:emitting,surface:'asphalt',slipPower:.8,contactPoint:p};
    });
    return {wheels,speedKmh:40};
  }
  addStrip(index, point, intensity) {
    const last=this.lastMark[index];
    if(!last){this.lastMark[index]={point:new THREE.Vector3().copy(point),left:null,right:null,distance:0};return;}
    const dx=point.x-last.point.x,dz=point.z-last.point.z,len=Math.hypot(dx,dz);
    if(len<.065)return;
    if(len>3){this.lastMark[index]=null;return;}
    const half=.10+intensity*.025, side=new THREE.Vector3(dz/len*half,0,-dx/len*half);
    const left=new THREE.Vector3().copy(point).add(side),right=new THREE.Vector3().copy(point).sub(side);
    const a=last.left??last.point.clone().add(side),b=last.right??last.point.clone().sub(side);
    const points=[a,b,left,left,b,right],u=[0,1,0,0,1,1],v=[last.distance,last.distance,last.distance+len,last.distance+len,last.distance,last.distance+len];
    const slot=this.markCursor;
    for(let j=0;j<6;j++){const p=points[j];this.markPositions.set([p.x,this.groundHeight(p),p.z],slot*18+j*3);this.markUvs.set([u[j],v[j]],slot*12+j*2);this.markStrength[slot*6+j]=intensity;}
    this.markCursor=(slot+1)%this.markCapacity;this.markCount=Math.min(this.markCapacity,this.markCount+1);
    this.marks.geometry.setDrawRange(0,this.markCount*6);
    for(const a of Object.values(this.marks.geometry.attributes))a.needsUpdate=true;
    this.lastMark[index]={point:new THREE.Vector3().copy(point),left,right,distance:last.distance+len};
  }
  groundHeight(point) {
    let height=Math.max(.020,point.y+.004);
    for(const surface of this.surfaceCells.get(Math.floor(point.x/4)+','+Math.floor(point.z/4))??[]){
      const p=this.surfacePoint.copy(point).applyMatrix4(surface.inverse);
      if(Math.abs(p.x)<=surface.half.x+.002&&Math.abs(p.z)<=surface.half.z+.002)height=Math.max(height,surface.top+.002);
    }
    return height;
  }
  spawn(point,surface,power,ageOffset=0) {
    const p=this.particles[this.particleCursor];this.particleCursor=(this.particleCursor+1)%this.particleCapacity;
    p.position.copy(point);p.position.x+=(this.random()-.5)*.18;p.position.z+=(this.random()-.5)*.18;p.position.y+=.12;
    p.velocity.set((this.random()-.5)*.65+.12,.30+this.random()*.36,(this.random()-.5)*.65);
    p.maxLife=1.8+this.random()*.9;p.life=p.maxLife+ageOffset;p.baseSize=.48+this.random()*.22;p.angle=this.random()*Math.PI*2;
    if(surface==='grass')p.color.setRGB(.36,.33,.23);else if(surface==='gravel')p.color.setRGB(.54,.46,.32);else p.color.setRGB(.86,.88,.9);
  }
  update(dt,telemetry,quaternion) {
    if(this.demo&&this.demoPaused)return;
    if(this.demo)telemetry=this.demoTelemetry(dt);
    else if(performance.now()<this.forcePreviewUntil)telemetry={...telemetry,wheels:telemetry.wheels.map(w=>({...w,slipPower:.75}))};
    const mode=this.demo?.mode;
    const showMarks=mode!=='smoke'&&mode!=='near',showSmoke=mode!=='marks';
    this.marks.visible=!this.legacyActive&&showMarks;
    if(this.legacy){this.legacy.marks.visible=this.legacyActive&&showMarks;this.legacy.smoke.visible=this.legacyActive&&showSmoke;}
    if(this.legacyActive){this.legacy.update(dt,telemetry,this.demo?.quaternion??quaternion);return;}
    for(let i=0;i<telemetry.wheels.length;i++){
      const w=telemetry.wheels[i],paved=w.surface==='asphalt'||w.surface==='kerb';
      if(!w.grounded){this.lastMark[i]=null;this.lastContact[i]=null;this.spawnCredit[i]=0;continue;}
      if(showMarks&&paved&&telemetry.speedKmh>16&&w.slipPower>.16)this.addStrip(i,w.contactPoint,Math.min(1,w.slipPower));else this.lastMark[i]=null;
      const rough=w.surface==='grass'||w.surface==='gravel';
      const emit=showSmoke&&((paved&&telemetry.speedKmh>20&&w.slipPower>.24)||(rough&&telemetry.speedKmh>12));
      if(emit){
        const rate=18+Math.min(1,w.slipPower)*22, previous=this.spawnCredit[i];this.spawnCredit[i]+=dt*rate;
        const count=Math.min(12,Math.floor(this.spawnCredit[i]));this.spawnCredit[i]-=count;
        for(let n=0;n<count;n++){const f=Math.min(1,(n+1-previous)/(dt*rate));this.temp.copy(this.lastContact[i]??w.contactPoint).lerp(w.contactPoint,f);this.spawn(this.temp,w.surface,w.slipPower,dt*f);}
      }else this.spawnCredit[i]=0;
      this.lastContact[i]=new THREE.Vector3().copy(w.contactPoint);
    }
    for(const p of this.particles)if(p.life>0){p.life-=dt;p.position.addScaledVector(p.velocity,dt);p.velocity.multiplyScalar(Math.exp(-dt*.45));p.velocity.y+=dt*.045;p.velocity.x+=Math.sin(this.time*2+p.angle)*dt*.12;p.velocity.z+=Math.cos(this.time*1.7+p.angle)*dt*.12;}
    this.time+=dt;
  }
  renderSmoke(renderer,camera,target,depthTexture,lighting) {
    if(this.legacyActive)return;
    const visible=this.visibleParticles;visible.length=0;camera.updateMatrixWorld();
    for(const p of this.particles)if(p.life>0){this.temp.copy(p.position).applyMatrix4(camera.matrixWorldInverse);if(this.temp.z<-.5){p.viewDepth=-this.temp.z;visible.push(p);}}
    visible.sort((a,b)=>b.viewDepth-a.viewDepth);
    const g=this.smoke.geometry,uniforms=this.smokeMaterial.uniforms;let count=0,coverage=0;
    const size=renderer.getDrawingBufferSize(uniforms.viewport.value);
    // A conservative projected-area budget supplements the particle cap.
    // Near-camera fade and this budget bound large overlapping smoke cards.
    for(const p of visible){
      const depth=p.viewDepth;
      const age=Math.max(0,1-p.life/p.maxLife),diameter=p.baseSize+age*1.45;
      const area=Math.min(1,Math.PI*(diameter*camera.projectionMatrix.elements[5]*size.y/(4*depth))**2/(size.x*size.y));
      const budget=THREE.MathUtils.clamp((3.5-coverage)/.7,0,1);if(budget<=0)continue;coverage+=area;
      const alpha=Math.min(1,age/.10)*Math.pow(1-age,1.35)*.20*budget;
      if(alpha<.002)continue;
      g.attributes.center.setXYZ(count,p.position.x,p.position.y,p.position.z);g.attributes.particleColor.setXYZ(count,p.color.r,p.color.g,p.color.b);
      g.attributes.diameter.setX(count,diameter);g.attributes.alpha.setX(count,alpha);g.attributes.angle.setX(count,p.angle+age*.15);count++;
    }
    g.instanceCount=count;this.info={particles:count,screenCoverage:Number(coverage.toFixed(3)),marks:this.markCount};
    if(!count)return;
    for(const a of Object.values(g.attributes))if(a.isInstancedBufferAttribute)a.needsUpdate=true;
    const sun=lighting.sun;
    uniforms.sceneDepth.value=depthTexture;uniforms.sunDepth.value=sun.shadow.map?.texture??depthTexture;
    uniforms.shadowReady.value=sun.shadow.map?1:0;uniforms.sunMatrix.value.copy(sun.shadow.matrix);
    uniforms.shadowTexel.value.set(1/sun.shadow.mapSize.x,1/sun.shadow.mapSize.y);
    uniforms.sunDirection.value.copy(lighting.direction);uniforms.sunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
    uniforms.cameraNear.value=camera.near;uniforms.cameraFar.value=camera.far;
    uniforms.fogColor.value.copy(this.scene.fog.color);uniforms.fogDensity.value=this.scene.fog.density;
    const autoClear=renderer.autoClear;renderer.autoClear=false;renderer.setRenderTarget(target);
    renderer.render(this.smokeScene,camera);renderer.autoClear=autoClear;
  }
}
