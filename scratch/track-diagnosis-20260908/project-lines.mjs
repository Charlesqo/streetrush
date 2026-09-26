import * as THREE from 'three';
const camera=new THREE.PerspectiveCamera(58,16/9,.1,1300);
camera.position.set(0,4.8,0);camera.lookAt(0,1.6,16.9);camera.updateMatrixWorld();
const W=1280,H=720;
const pixel=p=>{const v=p.clone().project(camera);return new THREE.Vector2((v.x+1)*W/2,(1-v.y)*H/2);};
const depth=p=>(p.clone().project(camera).z+1)/2;
const rows=[25,50,100,200,400,600].map(z=>{
 const stripeCenter=new THREE.Vector3(6.78,.043,z),delta=stripeCenter.clone().sub(camera.position);
 const roadPoint=camera.position.clone().addScaledVector(delta,(.015-camera.position.y)/delta.y);
 const edgeWidth=pixel(new THREE.Vector3(6.72,.043,z)).distanceTo(pixel(new THREE.Vector3(6.84,.043,z)));
 const gridThickness=pixel(new THREE.Vector3(2.2,.044,z-.08)).distanceTo(pixel(new THREE.Vector3(2.2,.044,z+.08)));
 return {distance:z,edgeWidthPixels:+edgeWidth.toFixed(4),gridThicknessPixels:+gridThickness.toFixed(4),depthSeparation24Bit:+(Math.abs(depth(roadPoint)-depth(stripeCenter))*(2**24-1)).toFixed(3),edgeAtScale072:+(edgeWidth*.72).toFixed(4)};
});
console.log(JSON.stringify({assumptions:{resolution:[W,H],fov:58,near:.1,far:1300,cameraHeight:4.8,lookTarget:[0,1.6,16.9],edgeWidth:.12,gridThickness:.16,roadY:.015,edgeY:.043,scope:'Analytical projection of representative straight-road view; not observed temporal flicker or GPU performance'},rows},null,2));
