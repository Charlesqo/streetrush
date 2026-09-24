import * as THREE from 'three';

// Faint accumulated tyre rubber follows selected corner corridors. It has no
// effect on surface IDs, collision shapes or friction. All strips share a draw.
export function installTrackSurfaceDetail(track, group) {
  const positions=[], colors=[], indices=[];
  const seen = new Set();
  for (const section of track.config.kerbSections ?? []) {
    if (section.id.includes('exit') || seen.has(section.start)) continue;
    seen.add(section.start);
    const start = Math.max(0, section.start - .013), end = section.end + .005;
    const n = Math.ceil((end-start)*track.length/1.2);
    const base = positions.length/3;
    for (let i=0;i<=n;i++) {
      const f=i/n, t=start+(end-start)*f;
      const s=track.pointAt(t);
      const apex = Math.sin(f*Math.PI);
      const offset=section.side*(2.4+apex*2.65);
      const fade=Math.min(1,f*7,(1-f)*7);
      for(const cross of [-1,-.55,.55,1]) {
        const p=s.point.clone().addScaledVector(s.side,offset+cross*.9);
        positions.push(p.x,p.y+.046,p.z);
        const edge=Math.abs(cross)===1?0:1;
        const grain=.72+.28*Math.sin(t*track.length*2.7+cross*8);
        colors.push(.012,.014,.015,edge*fade*grain*.19);
      }
      if(i<n)for(let j=0;j<3;j++){
        const a=base+i*4+j;
        indices.push(a,a+1,a+4,a+1,a+5,a+4);
      }
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,4));
  geometry.setIndex(indices);geometry.computeBoundingSphere();
  const material=new THREE.MeshBasicMaterial({vertexColors:true,transparent:true,depthWrite:false,side:THREE.DoubleSide});
  const rubber=new THREE.Mesh(geometry,material);rubber.name='Corner rubber deposits';rubber.renderOrder=1;group.add(rubber);
}
