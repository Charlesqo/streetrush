import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const cargoExecutable = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const userCargo = join(homedir(), '.cargo', 'bin', cargoExecutable);

async function resolveCargo() {
  if (process.env.CARGO) return process.env.CARGO;
  try {
    await access(userCargo);
    return userCargo;
  } catch {
    return cargoExecutable;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Cargo WASM build failed: code=${code ?? 'none'} signal=${signal ?? 'none'}`));
    });
  });
}

const cargo = await resolveCargo();
await run(cargo, [
  'build',
  '--locked',
  '--release',
  '-p',
  'streetrush-core',
  '--target',
  'wasm32-unknown-unknown',
]);

const source = join(
  projectRoot,
  'target',
  'wasm32-unknown-unknown',
  'release',
  'streetrush_core.wasm',
);
const destination = join(projectRoot, 'src', 'generated', 'streetrush_core.wasm');
await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
const { size } = await stat(destination);
console.log(`PASS generated Rust scheduler WASM ${size} bytes`);
