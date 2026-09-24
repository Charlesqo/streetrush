import * as THREE from 'three';
import {KERB_WIDTH,kerbHeight} from './longwan-layout.js';

export function createTrackKerbGeometry(track,section){
  const length=(section.end-section.start)*track.length;
  const count=Math.ceil(length/.125),positions=[],uvs=[],colors=[],indices=[];
  const red=new THREE.Color(0xac2724),white=new THREE.Color(0xd5d2c6);
  const vertex=(station,f)=>{
    const s=track.pointAt(section.start+station/track.length);
    const p=s.point.clone().addScaledVector(s.side,section.side*(track.config.width/2+f*KERB_WIDTH));
    p.y+=kerbHeight(station,f,length);return p;
  };
  for(let i=0;i<count;i++){
    const a=length*i/count,b=length*(i+1)/count,c=Math.floor((a+b)/2)%2?red:white;
    for(let j=0;j<3;j++){
      const f=j/3,g=(j+1)/3,base=positions.length/3;
      for(const [station,v] of [[a,f],[a,g],[b,f],[b,g]]){positions.push(...vertex(station,v).toArray());uvs.push(station/4,v/2);colors.push(c.r,c.g,c.b);}
      // side +1 points right: reverse the strip winding for upward normals.
      if(section.side===1)indices.push(base,base+2,base+1,base+1,base+2,base+3);
      else indices.push(base,base+1,base+2,base+1,base+3,base+2);
    }
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.setIndex(indices);g.computeVertexNormals();g.computeBoundingSphere();return g;
}
export function installTrackKerbs(track,material){
  track.kerbMeshes=[];
  for(const section of track.config.kerbSections??[]){
    const geometry=createTrackKerbGeometry(track,section);
    const mesh=new THREE.Mesh(geometry,material);mesh.name='kerb-'+section.id;mesh.receiveShadow=true;track.group.add(mesh);track.kerbMeshes.push(mesh);
  }
}
