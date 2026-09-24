import * as THREE from 'three';

// Integrate the repeating wire profile over each pixel footprint. A distant
// mesh converges to its mean coverage instead of flickering or vanishing when
// the individual wires become smaller than a pixel.
export function createSafetyMeshMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: 0x49534d, roughness: .7, metalness: .25,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'varying vec2 vFenceMetres;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vFenceMetres = uv * vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
    `);
    shader.fragmentShader = `varying vec2 vFenceMetres;
      float wireIntegral(float x, float duty) {
        return floor(x) * duty + min(fract(x), duty);
      }
      float filteredWire(float x) {
        float footprint = max(fwidth(x), .001);
        return clamp((wireIntegral(x + footprint * .5, .045) -
                      wireIntegral(x - footprint * .5, .045)) / footprint, 0., 1.);
      }
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphamap_fragment>', `
      #include <alphamap_fragment>
      vec2 diamond = vec2(vFenceMetres.x + vFenceMetres.y, vFenceMetres.x - vFenceMetres.y) / .095;
      float a = filteredWire(diamond.x), b = filteredWire(diamond.y);
      diffuseColor.a *= a + b - a * b;
    `);
  };
  material.customProgramCacheKey = () => 'longwan-filtered-wire-v1';
  return material;
}

// One upright card faces the camera instead of two intersecting cards. Source
// foliage silhouettes remain intact at oblique views and don't form an X.
export function createTreeMaterial(map) {
  const material = new THREE.MeshBasicMaterial({
    map, color: new THREE.Color(2.8, 2.85, 2.65), alphaTest: .2,
    alphaToCoverage: true, side: THREE.DoubleSide, fog: true,
  });
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      vec4 treeCenter = modelMatrix * instanceMatrix * vec4(0., 0., 0., 1.);
      vec3 towardCamera = cameraPosition - treeCenter.xyz;
      vec3 treeRight = normalize(vec3(towardCamera.z + .00001, 0., -towardCamera.x));
      vec3 treeWorld = treeCenter.xyz
        + treeRight * position.x * length(instanceMatrix[0].xyz)
        + vec3(0., position.y * length(instanceMatrix[1].xyz), 0.);
      vec4 mvPosition = viewMatrix * vec4(treeWorld, 1.);
      gl_Position = projectionMatrix * mvPosition;
    `);
  };
  const compileTree = material.onBeforeCompile;
  material.onBeforeCompile = shader => {
    compileTree(shader);
    // The source bake has near-black ambient shadows. Restore a small sky fill
    // for this unlit impostor without changing the game's light rig.
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #include <map_fragment>
      diffuseColor.rgb = pow(diffuseColor.rgb, vec3(.82)) + vec3(.012, .018, .008);
    `);
  };
  material.customProgramCacheKey = () => 'longwan-upright-tree-v2';
  return material;
}
