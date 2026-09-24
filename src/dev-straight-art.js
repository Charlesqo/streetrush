import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { installScanSurfaceSampling } from './scan-surface-sampling.js';
import { createRoadEnvironmentResponse } from './road-environment-response.js';

// Local art review. Uses the actual track, renderer, lights, fog and post-process.
// The downloaded originals remain outside the runtime; no physics data is edited.
const BASE = '/scratch/straight-art-20260916/assets/';
const END = .301;
const UP = new THREE.Vector3(0, 1, 0);

function band(track, from, to, start, end, height, tileSize, material) {
  const n = Math.ceil((end - start) * track.length / 1.5);
  const positions = [], uvs = [], indices = [];
  for (let i = 0; i <= n; i++) {
    const t = start + (end - start) * i / n;
    const sample = track.pointAt(t);
    for (const offset of [from, to]) {
      const p = sample.point.clone().addScaledVector(sample.side, offset);
      positions.push(p.x, p.y + height, p.z);
      uvs.push(t * track.length / tileSize, offset / tileSize);
    }
    if (i < n) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

function softGroundBand(track, from, to, height, material, feather = 1) {
  const steps = Math.ceil(END * track.length / 1.5), crossSteps = 16;
  const positions = [], uvs = [], colors = [], indices = [];
  for (let i = 0; i <= steps; i++) {
    const t = END * i / steps, station = t * track.length;
    const sample = track.pointAt(t);
    const edge = .16 * Math.sin(station * .53) + .11 * Math.sin(station * 1.91);
    for (let j = 0; j <= crossSteps; j++) {
      const f = j / crossSteps, offset = THREE.MathUtils.lerp(from, to, f) + edge * (1 - f);
      const p = sample.point.clone().addScaledVector(sample.side, offset);
      positions.push(p.x, p.y + height, p.z); uvs.push(station / 2, offset / 2);
      const fade = Math.min(1, f * (to - from) / feather, (1 - f) * (to - from) / feather);
      const tone = .97 + .025 * Math.sin(station * .07 + offset * .6) + .025 * Math.sin(station * .031);
      colors.push(tone, tone, tone, Math.max(0, fade));
      if (i < steps && j < crossSteps) {
        const a = i * (crossSteps + 1) + j, b = a + crossSteps + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const mat = material.clone(); mat.vertexColors = true; mat.transparent = true; mat.depthWrite = false;
  mat.onBeforeCompile = material.onBeforeCompile;
  mat.customProgramCacheKey = material.customProgramCacheKey;
  const mesh = new THREE.Mesh(geometry, mat); mesh.receiveShadow = true;
  return mesh;
}

function bakedParts(root) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const size = box.getSize(new THREE.Vector3());
    geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    parts.push({ name: mesh.name, geometry, material: mesh.material, size });
  });
  return parts;
}

function instances(geometry, material, placements, name) {
  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  mesh.name = name;
  const object = new THREE.Object3D();
  placements.forEach((p, i) => {
    object.position.copy(p.position);
    object.rotation.set(0, p.yaw, 0);
    object.scale.set(...(p.scale ?? [1, 1, 1]));
    object.updateMatrix();
    mesh.setMatrixAt(i, object.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.sceneryShadowCaster = true;
  return mesh;
}

export async function installStraightArt({ track, renderer }) {
  const loader = new THREE.TextureLoader();
  const manager = new THREE.LoadingManager();
  // HTML image loading avoids ImageBitmap decode failures in the embedded browser.
  manager.addHandler(/\.(png|jpe?g)$/i, new THREE.TextureLoader(manager));
  const gltf = new GLTFLoader(manager);
  const textureCache = new Map();
  const texture = async (key, channel, colour = false) => {
    const cacheKey = key + '/' + channel;
    if (!textureCache.has(cacheKey)) textureCache.set(cacheKey, loader.loadAsync(BASE + cacheKey + (channel === 'ORM' ? '.png' : '.jpg')).then(map => {
      map.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
      return map;
    }));
    return textureCache.get(cacheKey);
  };
  const surface = async (key, repeat = [1, 1]) => {
    const [map, normalMap, orm] = await Promise.all([
      texture(key, 'BaseColor', true), texture(key, 'Normal'), texture(key, 'ORM'),
    ]);
    const maps = [map, normalMap, orm].map(source => {
      const copy = source.clone(); copy.repeat.set(...repeat); return copy;
    });
    return new THREE.MeshStandardMaterial({ name: 'Megascans ' + key, map: maps[0], normalMap: maps[1],
      roughnessMap: maps[2], aoMap: maps[2], aoMapIntensity: .6, metalness: 0, roughness: 1 });
  };
  const originalLawn = track.environmentGroup.children.find(mesh => mesh.material?.map?.image?.src?.endsWith('/grass.jpg'))?.material;
  if (!originalLawn) throw new Error('Original circuit lawn material not found');
  const grassMat = originalLawn.clone();
  grassMat.map = originalLawn.map.clone();
  grassMat.map.repeat.set(.5,.5); // Original verge uses a 4-metre repeat.
  grassMat.vertexColors = false;
  grassMat.name = 'Original circuit lawn retained';
  const [roadMat, alternateMat, shoulderMat, gravelMat, guardrail, railMid, railLow, barrier, sparse, dense] = await Promise.all([
    surface('asphalt', [12 / 3, track.config.width / 3]),
    surface('fresh', [12 / 2, track.config.width / 2]),
    surface('asphalt', [4 / 3, 4 / 3]), surface('gravel'),
    gltf.loadAsync(BASE + 'guardrail/model.gltf'),
    gltf.loadAsync(BASE + 'guardrail-mid/model.gltf'), gltf.loadAsync(BASE + 'guardrail-low/model.gltf'),
    gltf.loadAsync(BASE + 'barrier/model.gltf'),
    gltf.loadAsync(BASE + 'rbojr/standard/rbojr_tier_1_nonUE.gltf'),
    gltf.loadAsync(BASE + 'rbptq/standard/rbptq_tier_1_nonUE.gltf'),
  ]);
  installScanSurfaceSampling(roadMat);
  installScanSurfaceSampling(shoulderMat);
  installScanSurfaceSampling(alternateMat, { neutral: .8, gain: 1.65 });
  const roadResponse = await createRoadEnvironmentResponse();
  for (const material of [roadMat, alternateMat, shoulderMat]) roadResponse.install(material);
  const group = new THREE.Group();
  group.name = 'Megascans complete main straight review';
  track.group.add(group);
  const swaps = [];
  const road = track.group.children.find(mesh => mesh.material?.name === 'dry-asphalt');
  const originalRoadMaterial = road.material;
  const roadGroups = road.geometry.groups.map(g => ({ ...g }));
  const count = Math.ceil(END * track.config.samples) * 6;
  const installRoad = material => {
    road.material = [originalRoadMaterial, material];
    road.geometry.clearGroups();
    road.geometry.addGroup(0, count, 1);
    road.geometry.addGroup(count, road.geometry.index.count - count, 0);
  };

  // Existing paved runoff remains paved, with the original widths and elevation.
  for (const mesh of track.environmentGroup.children) {
    if (mesh.material === originalRoadMaterial) swaps.push({ mesh, original: mesh.material, next: shoulderMat });
  }
  // Fill the entire outer verge. The pit apron continues to own the other side.
  gravelMat.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(.2126,.7152,.0722))), .58);');
  };
  gravelMat.customProgramCacheKey = () => 'straight-gravel-neutral-v1';
  group.add(softGroundBand(track, 12.05, 13.35, -.018, gravelMat, .36));
  group.add(softGroundBand(track, 12.6, 44, -.022, grassMat, 1.5));
  group.add(band(track, -30, -12, .182, END, -.024, 2, grassMat));

  const dust = await surface('dust');
  dust.alphaMap = await texture('dust', 'Opacity');
  dust.transparent = true; dust.depthWrite = false; dust.opacity = .55;
  // Source decal is 2 x 0.5 m. Keep its direction and feather the inside edge.
  for (const sign of [-1, 1]) {
    const decal = band(track, sign > 0 ? 11.25 : -11.75, sign > 0 ? 11.75 : -11.25,
      0, END, .020, 2, dust);
    const uv = decal.geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, i % 2);
    group.add(decal);
  }
  // Two authored maintenance patches on the paved pit-side shoulder.
  const patch = await surface('patch');
  patch.alphaMap = await texture('patch', 'Opacity');
  patch.transparent = true; patch.depthWrite = false;
  for (const [t, offset, angle] of [[.045,-9.6,.1],[.153,-9.8,-.08]]) {
    const s = track.pointAt(t, offset);
    const repair = new THREE.Mesh(new THREE.PlaneGeometry(.5,.5), patch);
    repair.rotation.set(-Math.PI/2,0,0); repair.rotateZ(-Math.atan2(s.tangent.z,s.tangent.x)+angle);
    repair.position.copy(s.point).addScaledVector(UP,.024); repair.receiveShadow=true;
    repair.name='Pit shoulder maintenance patch'; group.add(repair);
  }

  // Suppress only main-straight north-side concrete slabs; retain the same fence.
  // The double-row metal barrier fills the original boundary height visually.
  const wall = track.environmentGroup.getObjectByName('Circuit concrete walls');
  const originalMatrices = new Map();
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3();
  for (let i = 0; i < wall.count; i++) {
    wall.getMatrixAt(i, matrix); position.setFromMatrixPosition(matrix);
    const nearest = track.nearestInfo(position, null);
    if (nearest.t >= 0 && nearest.t <= END && nearest.offset > 0) originalMatrices.set(i, matrix.clone());
  }
  const railParts = bakedParts(guardrail.scene);
  const beams = railParts.filter(part => part.size.x > 2);
  const beamLevels = [beams, bakedParts(railMid.scene).filter(part=>part.size.x>2), bakedParts(railLow.scene).filter(part=>part.size.x>2)];
  const ends = railParts.filter(part => part.size.x < 1);
  const straightLength = END * track.length;
  const spacing = 4.20;
  const slots = Math.ceil(straightLength / spacing);
  for (let start = 0; start < slots; start += 8) {
    const lod = new THREE.LOD();
    const end = Math.min(slots,start+8);
    lod.position.copy(track.pointAt((start+end)*.5*straightLength/slots/track.length,11.6).point);
    const groups = beamLevels.map(()=>new THREE.Group());
    for (let variant = 0; variant < beams.length; variant++) {
      const placements = [];
      for (let i = start; i < Math.min(slots, start + 8); i++) {
        if (i % beams.length !== variant) continue;
        const station = (i + .5) * straightLength / slots;
        const s = track.pointAt(station / track.length, 11.6);
        for (const height of [.02, .57]) placements.push({ position: s.point.clone().addScaledVector(UP, height).sub(lod.position),
          yaw: -Math.atan2(s.tangent.z, s.tangent.x), scale: [(straightLength / slots + .09) / beams[variant].size.x, 1, 1] });
      }
      beamLevels.forEach((parts, level) => {
        const part = parts[variant];
        const fitted = placements.map(p=>({...p,scale:[p.scale[0]*beams[variant].size.x/part.size.x,1,1]}));
        const mesh = instances(part.geometry,beams[variant].material,fitted,'Straight guardrail '+start+'-'+variant+'-LOD'+level);
        if(level===2){mesh.castShadow=false;mesh.userData.sceneryShadowCaster=false;}
        groups[level].add(mesh);
      });
    }
    lod.addLevel(groups[0],0);lod.addLevel(groups[1],55,.12);lod.addLevel(groups[2],145,.12);group.add(lod);
  }
  // Loose stones accumulate by posts; none are scattered through the racing lane.
  let stoneSeed=31609;
  const stoneRandom=()=>{stoneSeed=(Math.imul(stoneSeed,1664525)+1013904223)>>>0;return stoneSeed/4294967296;};
  const stones=[];
  for(let i=0;i<slots;i++)for(let j=0;j<9;j++){
    const station=Math.max(0,Math.min(straightLength,i*straightLength/slots+(stoneRandom()-.5)*1.3));
    const s=track.pointAt(station/track.length,11.18+stoneRandom()*.44);
    const size=.01+stoneRandom()*.014;
    stones.push({position:s.point.clone().addScaledVector(UP,.016+size*.4),yaw:stoneRandom()*Math.PI*2,scale:[size,size*.4,size*.8]});
  }
  const pebbles=instances(new THREE.IcosahedronGeometry(1,0),new THREE.MeshStandardMaterial({color:0x837c68,roughness:1}),stones,'Loose gravel at guardrail posts');
  pebbles.castShadow=false;pebbles.userData.sceneryShadowCaster=false;group.add(pebbles);
  ends.forEach((part, i) => {
    const s = track.pointAt(i === 0 ? 0 : END, 11.6);
    group.add(instances(part.geometry, part.material, [{ position: s.point.clone().addScaledVector(UP, .02),
      yaw: -Math.atan2(s.tangent.z, s.tangent.x) + (i === 0 ? Math.PI : 0) }], 'Guardrail terminal ' + i));
  });
  // Scanned service barriers are used at one service area, not repeated around the lap.
  const concrete = bakedParts(barrier.scene)[0];
  const service = [];
  for (let i = 0; i < 5; i++) {
    const s = track.pointAt(.195 + i * 5.75 / track.length, -18);
    service.push({ position: s.point, yaw: -Math.atan2(s.tangent.z, s.tangent.x) });
  }
  group.add(instances(concrete.geometry, concrete.material, service, 'Scanned service barriers'));

  // High meshes near the camera; supplied LOD1 reuses the same 4K textures farther away.
  const plantSets = [bakedParts(sparse.scene), bakedParts(dense.scene)];
  const plants = plantSets.flatMap(parts => parts.filter(p => !/_LOD\d/.test(p.name)).map(high => ({
    high, mid: parts.find(p => p.name === high.name + '_LOD1') ?? high,
  })));
  for (const part of plants.flatMap(p => [p.high, p.mid])) {
    part.material.alphaTest = .38;
    part.material.alphaToCoverage = true;
    // Leaf transmission uses the existing sun and its already evaluated shadow.
    part.material.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
          float leafBackLight = pow(max(0.0, dot(-normal, directionalLights[0].direction)), 1.2);
          reflectedLight.directDiffuse += diffuseColor.rgb * directLight.color * leafBackLight * .14;
        #endif`);
    };
    part.material.customProgramCacheKey = () => 'straight-leaf-transmission-v1';
    for (const map of Object.values(part.material)) if (map?.isTexture) map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }
  let seed = 20260916;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let grassCount = 0;
  const chunkLength = 24;
  for (let start = 0; start < straightLength; start += chunkLength) {
    const lod = new THREE.LOD();
    lod.position.copy(track.pointAt((start + chunkLength / 2) / track.length, 17).point);
    const close = new THREE.Group(), far = new THREE.Group();
    const placements = plants.map(() => []);
    for (let i = 0; i < 440; i++) {
      const station = Math.min(straightLength, start + random() * chunkLength);
      const offset = 12.95 + Math.pow(random(), 1.7) * 9;
      if (random() < .08 + .05 * Math.sin(station * .11)) continue;
      const s = track.pointAt(station / track.length, offset);
      const scale = .78 + random() * .45;
      const variant = Math.floor(random() * plants.length);
      placements[variant].push({ position: s.point.clone().addScaledVector(UP, -.025).sub(lod.position),
        yaw: random() * Math.PI * 2, scale: [scale, scale * .65, scale] });
      grassCount++;
    }
    plants.forEach((part, i) => {
      if (!placements[i].length) return;
      close.add(instances(part.high.geometry, part.high.material, placements[i], 'Near grass ' + i));
      const farGrass=instances(part.mid.geometry, part.mid.material, placements[i], 'Far grass ' + i);
      farGrass.castShadow=false;farGrass.userData.sceneryShadowCaster=false;far.add(farGrass);
    });
    lod.addLevel(close, 0); lod.addLevel(far, 45, .12); lod.addLevel(new THREE.Group(), 145, .12);
    group.add(lod);
  }
  group.updateMatrixWorld(true);
  let enabled = true, fresh = false;
  const state = {
    length: straightLength, grassCount, guardrailModules: slots, plants: plants.map(p => ({ name: p.high.name, size: p.high.size.toArray() })),
    get enabled() { return enabled; },
    get responseEnabled() { return roadResponse.enabled; },
    setResponseEnabled(value) { roadResponse.setEnabled(value); },
    withOriginalResponse(callback) {
      const previous = roadResponse.enabled;
      roadResponse.setEnabled(false);
      try { return callback(); } finally { roadResponse.setEnabled(previous); }
    },
    setEnabled(value) {
      enabled = value; group.visible = value;
      swaps.forEach(swap => { swap.mesh.material = value ? swap.next : swap.original; });
      if (value) installRoad(fresh ? alternateMat : roadMat);
      else {
        road.material = originalRoadMaterial;
        road.geometry.clearGroups(); roadGroups.forEach(g => road.geometry.addGroup(g.start, g.count, g.materialIndex));
      }
      for (const [index, original] of originalMatrices) wall.setMatrixAt(index, value ? new THREE.Matrix4().makeScale(0, 0, 0) : original);
      wall.instanceMatrix.needsUpdate = true;
    },
    toggleAsphalt() { fresh = !fresh; if (enabled) installRoad(fresh ? alternateMat : roadMat); return fresh ? 'Asphalt Fresh' : 'Fine Asphalt'; },
  };
  state.setEnabled(true);
  track.straightArt = state;
  return state;
}
