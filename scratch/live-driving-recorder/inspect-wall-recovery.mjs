import fs from 'node:fs';
import { registerHooks } from 'node:module';
const variant=process.argv[2]??'fixed';
registerHooks({load(url,context,next){
  const result=next(url,context);
  let source=String(result.source);
  if(url.endsWith('/src/vehicle-v24/runtime.js')&&variant==='before') {
    source=fs.readFileSync('research-output/wheel-reaction-fix/runtime.before.js','utf8');
    return {...result,source};
  }
  if(url.endsWith('/scripts/test-vehicle-v24-playability.mjs')){
    const seam="assert.ok(final.signedBodySpeed > 1, 'forward drive did not resume after reverse escape');";
    if(!source.includes(seam))throw Error('Wall audit seam changed');
    source="import fs from 'node:fs';\n"+source.replace(seam,`fs.writeFileSync('research-output/wheel-reaction-fix/wall-${variant}.json', JSON.stringify({collision,pushRows,brakeRows,reverseRows,escapeRows,final,report:rig.vehicle.getVehiclePhysicsReport(),state:rig.vehicle.vehicleV24.getStateSnapshot()}));\n    ${seam}`);
    return {...result,source};
  }
  return result;
}});
await import('../../scripts/test-vehicle-v24-playability.mjs');
