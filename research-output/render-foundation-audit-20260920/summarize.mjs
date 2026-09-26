import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const root=new URL('../../',import.meta.url),dir=new URL('./',import.meta.url);
const frames=[];
for(const file of (await readdir(dir)).filter(f=>/^normal-.*\.json$/.test(f))){
  const j=JSON.parse(await readFile(new URL(file,dir),'utf8'));
  const materialById=new Map(j.materials.map(m=>[m.id,m]));
  const carIds=new Set(j.meshes.filter(o=>o.car).flatMap(o=>o.materials));
  frames.push({file,car:j.car,mode:j.mode,recordedAt:j.recordedAt,resolution:j.drawingBuffer,renderer:j.renderer,
    environment:j.environment,ao:{size:j.ao.size,normalTexture:j.ao.normalTexture,blend:j.ao.blend},
    passTargets:j.passes.map(p=>({object:p.object,material:p.material,target:p.target})),
    carMaterials:j.materials.filter(m=>carIds.has(m.id)).map(m=>({name:m.name,type:m.type,role:m.role,transmission:m.transmission,metalness:m.metalness,clearcoat:m.clearcoat})),
    trees:j.meshes.filter(o=>o.name.includes('Jacaranda')).map(o=>({name:o.name,count:o.instances,castShadow:o.castShadow,receiveShadowFlag:o.receiveShadow,material:materialById.get(o.materials[0]).type})),
    megascansMaterials:j.materials.filter(m=>/Megascans/i.test(m.name)).length,
    transmissionMaterials:j.materials.filter(m=>m.transmission>0).length,
    lightMapMaterials:j.materials.filter(m=>m.maps.lightMap).length,
    roadMaps:j.materials.find(m=>m.name==='dry-asphalt')?.maps,
    contactShadow:j.meshes.find(m=>m.name==='contact-shadow'),
  });
}
const files=['src/main.js','src/rendering.js','src/render-pipeline.js','src/car-materials.js','src/assets.js','src/track-environment.js','src/track-detail-materials.js','src/dev-straight-art.js','package.json','public/cars/porsche-gt3-rs.glb'];
const sourceHashes={};for(const file of files)sourceHashes[file]=createHash('sha256').update(await readFile(new URL(file,root))).digest('hex');
await writeFile(new URL('evidence-summary.json',dir),JSON.stringify({recordedAt:new Date().toISOString(),sourceHashes,frames,limits:['Read-only observer on a separate dev server, using the normal production entry code and default quality controller.','No renderreview flag, camera override, lighting override, or material override.','PNG export and state traversal add capture overhead; not a performance benchmark.','Static menu and stationary race frames only; no all-track, moving-image, physical-fidelity, or cross-device acceptance.']},null,2));
console.log(JSON.stringify(frames.map(f=>({file:f.file,car:f.car,resolution:f.resolution,megascans:f.megascansMaterials,treeCount:f.trees.reduce((n,t)=>n+t.count,0),carMaterials:f.carMaterials.length})),null,2));
