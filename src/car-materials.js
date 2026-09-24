import * as THREE from 'three';

// Exporter names are the authority for ambiguous materials. Atlas materials
// retain their authored channel maps; no blanket metalness override is applied.
const MX5_ROLES = {
  'Material.002': 'paint', 'Material.001': 'plastic', 'Material.010': 'glass',
  'Material.004': 'glass', 'Material.008': 'glass', 'Material.014': 'rubber',
};

export function carMaterialRole(name, carId) {
  if (carId === 'mx5' && MX5_ROLES[name]) return MX5_ROLES[name];
  if (/glass|windows?|vitre|^Feux_glass$/i.test(name)) return 'glass';
  if (/rubber|tyres?|tires?|^pneu$/i.test(name)) return 'rubber';
  if (/plastic|plastique|carbon|alcantara|fabric|leather|carpet|seat|siege|interieur/i.test(name)) return 'plastic';
  if (/carpaint|_paint$|^Body$|^paint_orange/i.test(name)) return 'paint';
  if (/chrome|^jante$|^miroir$|^metal_|_metal$|^disk$|brake_dis[ck]|ext_disc/i.test(name)) return 'metal';
  return 'authored';
}

function physicalCopy(source) {
  if (source.isMeshPhysicalMaterial) return source.clone();
  const material = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(material, source);
  // Standard.copy resets defines; retain the physical IOR/specular branch.
  material.defines = { STANDARD: '', PHYSICAL: '' };
  return material;
}

export function refineCarMaterials(root, carId) {
  const cache = new Map();
  function refine(source) {
    if (!source?.isMeshStandardMaterial) return source;
    if (cache.has(source)) return cache.get(source);
    const role = carMaterialRole(source.name, carId);
    const material = role === 'paint' || role === 'glass' ? physicalCopy(source) : source.clone();
    cache.set(source, material);
    material.userData.streetRushRole = role;
    if (role === 'paint') {
      // Lacquer over pigment: the clear coat carries sharp highlights while the
      // base layer stays broad. Keep livery/base colour and packed detail maps.
      material.roughness = .3;
      material.metalness = carId === 'gt3rs' || carId === 'm5g90' ? .4 : .12;
      material.clearcoat = 1;
      material.clearcoatRoughness = .13;
      material.specularIntensity = 1;
    } else if (role === 'glass') {
      material.metalness = 0;
      material.roughness = .09;
      material.clearcoat = .65;
      material.clearcoatRoughness = .08;
      material.specularIntensity = 1;
      material.transmission = 0;
      material.depthWrite = !material.transparent;
      if (!material.map) material.color.setHex(0x435660);
      // Draw a thin pane once; back-to-back transparent faces darken windows.
      material.side = THREE.FrontSide;
    } else if (role === 'rubber' || role === 'plastic') {
      material.metalness = 0;
      material.roughness = role === 'rubber' ? .86 : /carbon/i.test(source.name) ? .46 : .65;
      if (material.isMeshPhysicalMaterial) {
        material.clearcoat = /carbon/i.test(source.name) ? .25 : 0;
        material.specularIntensity = .8;
      }
      if (!material.map && Math.max(material.color.r, material.color.g, material.color.b) < .005) material.color.setRGB(.008, .009, .01);
    } else if (role === 'metal') {
      material.metalness = .9;
      material.roughness = /miroir|mirror/i.test(source.name) ? .07 : .28;
      if (!material.map && Math.max(material.color.r, material.color.g, material.color.b) < .005) material.color.setRGB(.05, .055, .06);
    }
    if (material.isMeshPhysicalMaterial) {
      material.clearcoatRoughness = Math.max(.08, material.clearcoatRoughness);
      // Tiny headlamp lenses also use the existing alpha blend. Avoid the extra
      // full-scene transmission prepass on the imported E30/MX5 models.
      if (material.transparent) { material.transmission = 0; material.depthWrite = false; }
    }
    return material;
  }
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.material = Array.isArray(object.material) ? object.material.map(refine) : refine(object.material);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    object.castShadow = materials.every((m) => !m.transparent || m.alphaTest > 0);
    object.receiveShadow = true;
  });
}

let contactTexture;
export function createContactShadowMaterial() {
  if (!contactTexture) {
    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const r = Math.hypot((x + .5) / size * 2 - 1, (y + .5) / size * 2 - 1);
      const alpha = Math.pow(Math.max(0, 1 - r * r), 2);
      data.set([255, 255, 255, Math.round(alpha * 255)], (y * size + x) * 4);
    }
    contactTexture = new THREE.DataTexture(data, size, size);
    contactTexture.magFilter = contactTexture.minFilter = THREE.LinearFilter;
    contactTexture.needsUpdate = true;
  }
  return new THREE.MeshBasicMaterial({
    name: 'soft-contact-occlusion', map: contactTexture, color: 0x101316,
    transparent: true, opacity: .36, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1,
  });
}
