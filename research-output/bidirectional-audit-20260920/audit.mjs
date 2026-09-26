import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CARS } from '../../src/config.js';
import { carMaterialRole } from '../../src/car-materials.js';
import { parseGlb } from '../../scripts/car-model-structure.mjs';

const dir = new URL('./', import.meta.url);
const save = (name, data) => writeFile(new URL(name, dir), JSON.stringify(data, null, 2));
const paths = ['src/main.js', 'src/rendering.js', 'src/render-pipeline.js', 'src/car-materials.js', 'src/assets.js', 'src/track-detail-materials.js', 'src/effects.js', 'src/tire-effects.js', 'scripts/test-render-materials.mjs'];
const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
const before = await hashes();
const sourceMaterials = [];
for (const car of CARS) {
  const { json } = parseGlb(await readFile(`public/cars/${car.file}`));
  sourceMaterials.push({ car: car.id, materials: (json.materials ?? []).map((m, index) => ({
    index, name: m.name, classifiedRole: carMaterialRole(m.name ?? '', car.id),
    pbr: m.pbrMetallicRoughness, alphaMode: m.alphaMode ?? 'OPAQUE', doubleSided: m.doubleSided ?? false,
    extensions: m.extensions, normalTexture: m.normalTexture, occlusionTexture: m.occlusionTexture,
    users: json.meshes.flatMap(mesh => mesh.primitives.some(p => p.material === index) ? [mesh.name] : []),
  })) });
}
await save('source-materials.json', sourceMaterials);
console.log('Source inventory:', sourceMaterials.map(c => ({ car: c.car, materials: c.materials.length, roles: Object.fromEntries([...new Set(c.materials.map(m => m.classifiedRole))].map(role => [role, c.materials.filter(m => m.classifiedRole === role).length])) })));

const require = createRequire(import.meta.url);
const { chromium } = require(join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => { errors.push(String(e)); console.log('PAGE ERROR', String(e)); });
page.on('requestfailed', r => console.log('FAILED REQUEST', r.url(), r.failure()));
page.on('console', msg => { if (['error','warning'].includes(msg.type())) { errors.push(msg.text()); console.log(msg.type(), msg.text()); } });
try {
  await page.goto('http://127.0.0.1:5187/', { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  console.log('Page reached', await page.title());
  const progress = setInterval(async () => { try { console.log('Progress', await page.evaluate(() => ({url:location.href,hook:!!window.__bidirectionalAudit,status:document.querySelector('#loading-status')?.textContent,resources:performance.getEntriesByType('resource').length}))); } catch {} }, 10000);
  try { await page.waitForFunction(() => window.__bidirectionalAudit || document.querySelector('#loading-status')?.textContent.includes('启动失败'), null, { timeout: 60000, polling: 100 }); }
  finally { clearInterval(progress); }
  if (!await page.evaluate(() => !!window.__bidirectionalAudit)) throw new Error(await page.locator('#loading-status').textContent());
  console.log('Boot facts', await page.evaluate(() => {const a=window.__bidirectionalAudit;return {state:a.state,car:a.vehicle?.config?.id,vehicleKeys:Object.keys(a.vehicle??{}),garage:document.querySelector('#garage-status')?.textContent};}));
  if (!await page.evaluate(() => !!window.__bidirectionalAudit.vehicle)) throw new Error('Normal entry completed without a vehicle; visual audit cannot proceed. See recorded startup warnings.');
  await page.evaluate(() => window.__bidirectionalAudit.freeze());
  const snapshot = () => page.evaluate(() => {
    const a = window.__bidirectionalAudit, { THREE, scene, renderer, lighting, renderPipeline: pipeline } = a;
    const materials = new Map(), meshes = [], lights = [];
    scene.updateMatrixWorld(true);
    scene.traverseVisible(o => {
      if (o.isLight) lights.push({ type: o.type, name: o.name, intensity: o.intensity, castShadow: o.castShadow });
      if (!o.isMesh) return;
      const ms = [].concat(o.material);
      for (const m of ms) if (!materials.has(m.uuid)) materials.set(m.uuid, {
        uuid: m.uuid, name: m.name, type: m.type, role: m.userData.streetRushRole,
        color: m.color?.toArray(), roughness: m.roughness, metalness: m.metalness,
        clearcoat: m.clearcoat, opacity: m.opacity, transparent: m.transparent,
        depthWrite: m.depthWrite, alphaTest: m.alphaTest, transmission: m.transmission,
        map: !!m.map, normalMap: !!m.normalMap, aoMap: !!m.aoMap, lightMap: !!m.lightMap, envMap: !!m.envMap,
      });
      const b = new THREE.Box3().setFromObject(o);
      meshes.push({ name: o.name, geometry: o.geometry.type, materials: ms.map(m => m.uuid),
        instances: o.isInstancedMesh ? o.count : 1, castShadow: o.castShadow, receiveShadow: o.receiveShadow,
        bounds: { min: b.min.toArray(), max: b.max.toArray() }, position: o.getWorldPosition(new THREE.Vector3()).toArray() });
    });
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { date: new Date().toISOString(), car: a.vehicle.config.id, source: a.vehicle.visual.userData.source,
      position: a.vehicle.visual.position.toArray(), camera: { position: a.camera.position.toArray(), fov: a.camera.fov },
      buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], gpu: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
      color: { output: renderer.outputColorSpace, toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure },
      environment: { uuid: scene.environment.uuid, intensity: scene.environmentIntensity, preset: lighting.preset },
      shadow: { map: lighting.sun.shadow.mapSize.toArray(), span: lighting.sun.shadow.camera.right * 2, normalBias: lighting.sun.shadow.normalBias },
      ao: { size: [pipeline.ao.width, pipeline.ao.height], normalTexture: !!pipeline.ao.normalTexture, intensity: pipeline.ao.blendIntensity, samples: pipeline.ao.gtaoMaterial.defines.SAMPLES, blendSrc: pipeline.ao.blendMaterial.blendSrc, blendDst: pipeline.ao.blendMaterial.blendDst },
      msaa: pipeline.msaaSamples, lights, materials: [...materials.values()], meshes };
  });
  const capture = async name => {
    const png = await page.evaluate(() => window.__bidirectionalAudit.draw());
    await writeFile(new URL(`${name}.png`, dir), Buffer.from(png.split(',')[1], 'base64'));
  };
  await capture('normal-mx5');
  await save('normal-mx5.json', await snapshot());
  await page.evaluate(() => {
    const a = window.__bidirectionalAudit;
    a.camera.position.set(-332, 4.8, -2.5); a.camera.lookAt(-290, 1, 0); a.camera.updateMatrixWorld();
  });
  await capture('whole-scene');
  await page.evaluate(() => window.__bidirectionalAudit.renderPipeline.ao.blendIntensity = 0);
  await capture('whole-scene-no-gtao');
  await page.evaluate(() => window.__bidirectionalAudit.renderPipeline.ao.blendIntensity = .75);
  const carReports = [];
  for (const id of CARS.map(c => c.id)) {
    await page.evaluate(async id => { const a = window.__bidirectionalAudit; await a.mount(id); a.freeze(); }, id);
    await capture(`car-${id}`);
    const data = await snapshot();
    carReports.push({car:id,source:data.source,materials:data.materials.filter(m=>m.role)});
    console.log('Loaded car', id, data.source, 'material count', carReports.at(-1).materials.length);
  }
  await save('runtime-car-materials.json', carReports);
  // An invariance check: this moves only the visual root in an audit instance.
  // No claim is made about physical suspension or jumping behavior.
  const contact = await page.evaluate(() => {
    const a = window.__bidirectionalAudit, v = a.vehicle.visual, p = v.position.clone();
    const plane = v.getObjectByName('contact-shadow'), before = plane.getWorldPosition(new a.THREE.Vector3()).toArray();
    v.position.y += 2; v.updateMatrixWorld(true);
    const after = plane.getWorldPosition(new a.THREE.Vector3()).toArray();
    v.position.copy(p); v.updateMatrixWorld(true);
    return {before,after,localY:plane.position.y,opacity:plane.material.opacity,explanation:'Visual-root transform only; fixed plane moves up by the same 2 metres.'};
  });
  await save('contact-invariance.json', contact);
  console.log('Contact plane test', contact);
} finally {
  await browser.close();
  const after = await hashes();
  await save('run-manifest.json', { before, after, sourceUnchanged: JSON.stringify(before) === JSON.stringify(after), errors, note: 'Audit instrumentation only; captures are not benchmarks. The normal warmup and renderer settings are preserved. All live runtime edits are discarded when this browser closes.' });
}
