import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

// One outdoor light rig shared by the visible sky, PBR materials and sun shadow.
// The sky is prefiltered once; there are no per-frame cube-map captures.
export function createOutdoorLighting(renderer, scene, { mobile = false } = {}) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const direction = new THREE.Vector3(0.94, 0.48, -0.22).normalize();
  const sky = new Sky();
  sky.name = 'outdoor-sky';
  sky.material.uniforms.skyGain = { value: 1 };
  sky.material.fragmentShader = 'uniform float skyGain;\n' + sky.material.fragmentShader.replace('vec4( retColor, 1.0 )', 'vec4( retColor * skyGain, 1.0 )');
  sky.scale.setScalar(10000);
  sky.material.uniforms.turbidity.value = 2.8;
  sky.material.uniforms.rayleigh.value = 1.8;
  sky.material.uniforms.mieCoefficient.value = 0.003;
  sky.material.uniforms.mieDirectionalG.value = 0.8;
  sky.material.uniforms.sunPosition.value.copy(direction).multiplyScalar(450000);
  sky.frustumCulled = false;
  scene.add(sky);
  scene.background = null;
  scene.fog = new THREE.FogExp2(0xbacbd0, 0.00058);

  const capture = new THREE.Scene();
  capture.add(sky.clone());
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(10000, 10000),
    new THREE.MeshBasicMaterial({ color: 0x626b58 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -10;
  capture.add(ground);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let environment = pmrem.fromScene(capture, 0.025, 0.1, 20000);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.8;
  pmrem.dispose();
  ground.geometry.dispose();
  ground.material.dispose();

  const fill = new THREE.HemisphereLight(0xd2e6ff, 0x716348, 0.4);
  // Cover the road ahead as well as the car, using the existing shadow map.
  let shadowSpan = 112;
  let shadowLookAhead = 24;
  const sun = new THREE.DirectionalLight(0xffeed6, 3.3);
  sun.name = 'afternoon-sun';
  sun.position.copy(direction).multiplyScalar(100);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(mobile ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -shadowSpan / 2, right: shadowSpan / 2, top: shadowSpan / 2, bottom: -shadowSpan / 2, near: 1, far: 190 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.00024;
  sun.shadow.normalBias = 0.03 * 2048 / sun.shadow.mapSize.x;
  sun.shadow.autoUpdate = false;
  scene.add(fill, sun, sun.target);

  // Quantize the shadow origin in light space to keep the road from shimmering.
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
  const up = new THREE.Vector3().crossVectors(direction, right).normalize();
  const focus = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const lastPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
  const lastRotation = new THREE.Quaternion();
  let lastVisual = null;
  let lastUpdate = -Infinity;
  let preset = 'original';
  let hdrSky = null;
  let hdrTexture = null;
  // Cross-light the starting straight: the original sun ran almost along
  // the barriers, leaving their ground shadows mostly outside the track.
  let skyRotation = .35;
  let venuePosition = new THREE.Vector3(-55, 2.5, 12);
  async function setPreset(name, vehicleVisual) {
    if (!['original', 'clear', 'hdri'].includes(name)) throw new Error('Unknown sky preset');
    if (name === 'hdri' && !hdrSky) {
      hdrTexture = await new HDRLoader().loadAsync('/textures/sky/kloofendal_48d_partly_cloudy_puresky_2k.hdr');
      hdrSky = new THREE.Mesh(new THREE.BoxGeometry(10000, 10000, 10000), new THREE.ShaderMaterial({
        name: 'photographed-daylight-sky', side: THREE.BackSide, depthWrite: false,
        uniforms: { skyMap: { value: hdrTexture }, captureMode: { value: 0 }, rotation: { value: skyRotation }, gain: { value: 1 } },
        vertexShader: 'varying vec3 worldPosition; void main(){ vec4 p=modelMatrix*vec4(position,1.); worldPosition=p.xyz; gl_Position=projectionMatrix*viewMatrix*p; gl_Position.z=gl_Position.w; }',
        fragmentShader: `uniform sampler2D skyMap; uniform float rotation, gain, captureMode; varying vec3 worldPosition;
          void main(){ vec3 d=normalize(worldPosition-cameraPosition); vec2 uv=vec2(fract((atan(d.z,d.x)-rotation)/6.2831853+.5),asin(clamp(d.y,-1.,1.))/3.14159265+.5);
          vec3 radiance=texture2D(skyMap,uv).rgb;
          // Suppress the tiny sun disc in the IBL capture. Direct sunlight owns
          // sharp solar illumination and its occlusion; clouds remain in IBL.
          radiance=mix(radiance,min(radiance,vec3(8.)),captureMode);
          gl_FragColor=vec4(radiance*gain,1.);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          }`,
      }));
      hdrSky.frustumCulled = false;
      scene.add(hdrSky);
    }
    preset = name;
    sky.visible = name !== 'hdri';
    if (hdrSky) hdrSky.visible = name === 'hdri';
    const original = name === 'original';
    Object.assign(sky.material.uniforms.turbidity, { value: original ? 2.8 : 1.7 });
    sky.material.uniforms.rayleigh.value = original ? 1.8 : 2.5;
    sky.material.uniforms.mieCoefficient.value = original ? .003 : .002;
    sky.material.uniforms.skyGain.value = original ? 1 : .42;
    direction.set(.94, .48, -.22).normalize();
    if (name === 'hdri') {
      // Measured maximum-radiance texel: (1218.5,239.5) in 2048x1024.
      const elevation = Math.PI * (.5 - 239.5 / 1024);
      hdrSky.material.uniforms.rotation.value = skyRotation;
      const azimuth = (1218.5 / 2048 - .5) * Math.PI * 2 + skyRotation;
      direction.set(Math.cos(elevation)*Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation)*Math.sin(azimuth));
    }
    sky.material.uniforms.sunPosition.value.copy(direction).multiplyScalar(450000);
    right.crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
    up.crossVectors(direction, right).normalize();
    sun.intensity = original ? 3.3 : 3.5;
    fill.intensity = original ? .4 : .48;
    scene.fog.color.setHex(original ? 0xbacbd0 : 0xb8cad5);
    scene.fog.density = original ? .00058 : .00038;
    lastVisual = null;
    update(vehicleVisual, performance.now());
    captureVenue(venuePosition, vehicleVisual);
  }
  function update(visual, now) {
    if (!visual) return;
    const changed = visual !== lastVisual || visual.position.distanceToSquared(lastPosition) > 0.000025
      || 1 - Math.abs(visual.quaternion.dot(lastRotation)) > 0.000001;
    if (!changed || now - lastUpdate < (mobile ? 1000 / 30 : 0)) return;
    focus.copy(visual.position);
    forward.set(0, 0, 1).applyQuaternion(visual.quaternion);
    forward.y = 0;
    focus.addScaledVector(forward.normalize(), shadowLookAhead);
    const texel = shadowSpan / sun.shadow.mapSize.x;
    focus.addScaledVector(right, Math.round(focus.dot(right) / texel) * texel - focus.dot(right));
    focus.addScaledVector(up, Math.round(focus.dot(up) / texel) * texel - focus.dot(up));
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(direction, 100);
    sun.target.updateMatrixWorld();
    sun.shadow.needsUpdate = true;
    lastPosition.copy(visual.position);
    lastRotation.copy(visual.quaternion);
    lastVisual = visual;
    lastUpdate = now;
  }
  function prepareScenery(root) {
    root.traverse((object) => {
      if (!object.isMesh) return;
      object.receiveShadow = true;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      object.castShadow = object.userData.sceneryShadowCaster ?? (materials.every((m) => !m.transparent)
        && ['BoxGeometry', 'CylinderGeometry', 'ConeGeometry'].includes(object.geometry.type));
    });
  }
  function captureVenue(position, vehicleVisual) {
    // Bake the real pit buildings, barriers and sky once at track-side height.
    // A static venue probe gives the paint a readable horizon without six extra
    // scene draws per frame. The vehicle must never reflect its own capture.
    const visible = vehicleVisual?.visible;
    const shadows = renderer.shadowMap.enabled;
    const fog = scene.fog;
    venuePosition.copy(position);
    if (hdrSky) hdrSky.material.uniforms.captureMode.value = 1;
    if (vehicleVisual) vehicleVisual.visible = false;
    renderer.shadowMap.enabled = false;
    scene.fog = null;
    const generator = new THREE.PMREMGenerator(renderer);
    try {
      const next = generator.fromScene(scene, 0.025, 0.1, 1500, { position, size: 256 });
      scene.environment = next.texture;
      environment.dispose();
      environment = next;
    } finally {
      generator.dispose();
      if (vehicleVisual) vehicleVisual.visible = visible;
      renderer.shadowMap.enabled = shadows;
      scene.fog = fog;
      if (hdrSky) hdrSky.material.uniforms.captureMode.value = 0;
    }
  }
  return { update, prepareScenery, captureVenue, setPreset, sun, fill, direction, get preset() { return preset; },
    async setSkyRotation(value, visual) { skyRotation = value; await setPreset('hdri', visual); },
    setShadowCoverage(span, lookAhead, visual) {
      shadowSpan = span; shadowLookAhead = lookAhead;
      Object.assign(sun.shadow.camera, { left: -span / 2, right: span / 2, top: span / 2, bottom: -span / 2 });
      sun.shadow.normalBias = .015 * span / 56 * 2048 / sun.shadow.mapSize.x;
      sun.shadow.bias = -.00012 * span / 56;
      sun.shadow.camera.updateProjectionMatrix();
      lastVisual = null; lastUpdate = -Infinity; update(visual, performance.now());
    },
    dispose() { environment.dispose(); sky.geometry.dispose(); sky.material.dispose(); hdrSky?.geometry.dispose(); hdrSky?.material.dispose(); hdrTexture?.dispose(); } };
}

// Photographed CC0 aggregate, OpenGL normals and packed AO/roughness. The source
// patch is 2.1 metres square; road UVs advance once per 12 m and span its width.
export function createAsphaltMaterial(renderer, roadWidth) {
  const loader = new THREE.TextureLoader();
  const load = (suffix, color = false) => {
    const texture = loader.load(`/textures/asphalt/asphalt_01_${suffix}_1k.jpg`);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(12 / 2.1, roadWidth / 2.1);
    texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return texture;
  };
  const arm = load('arm');
  return new THREE.MeshStandardMaterial({
    name: 'dry-asphalt', map: load('diff', true), color: 0xb4bec8,
    metalness: 0, roughness: 1, roughnessMap: arm, aoMap: arm, aoMapIntensity: .55,
    normalMap: load('nor_gl'), normalScale: new THREE.Vector2(.8, .8),
  });
}
