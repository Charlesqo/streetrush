import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Actual browser page + DOM keyboard events + production input and main loop.
// node scripts/record-flat-braking-keyboard.mjs
// Optional dependencies: PLAYWRIGHT_MODULE and CHROME_PATH environment variables.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch {
  playwright = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.USERPROFILE,
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
}
const outputRoot = path.join(root, 'research-output/flat-braking-keyboard');
fs.mkdirSync(outputRoot, { recursive: true });
const out = fs.mkdtempSync(path.join(outputRoot, 'lp700-200-'));
const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
const sourceFiles = ['src/main.js', 'src/input.js', 'src/vehicle.js', 'src/vehicle-physics.js', 'src/config.js',
  'src/track.js', 'src/straight-line-diagnostic.js', 'src/physics-scheduling.js',
  'scripts/straight-line-recorder-plugin.mjs', 'scripts/record-flat-braking-keyboard.mjs'];
function addSources(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) addSources(`${dir}/${entry.name}`);
    else if (entry.name.endsWith('.js')) sourceFiles.push(`${dir}/${entry.name}`);
  }
}
addSources('src/vehicle-v24');
const hashes = () => Object.fromEntries(sourceFiles.map(name => [name,
  createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
const sourceSha256 = hashes();
const port = 5191;
const origin = `http://127.0.0.1:${port}`;
const url = `${origin}/?straightline=1&car=lp700&targetkmh=200&coastseconds=0`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '', serverFailure = null, browser, page, result;
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });
server.on('error', error => { serverFailure = error.message; });
const errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  for (let tries = 0; ; tries++) {
    if (serverFailure || server.exitCode !== null) throw new Error(`Vite failed: ${serverFailure || serverLog}`);
    if (serverLog.includes('Local:')) break;
    if (tries > 100) throw new Error('Vite startup timeout');
    await delay(100);
  }
  browser = await playwright.chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--autoplay-policy=no-user-gesture-required'] });
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript(() => {
    window.__flatBrakingKeyboardAudit = [];
    for (const type of ['keydown', 'keyup']) addEventListener(type, event => {
      window.__flatBrakingKeyboardAudit.push({ type, code: event.code, key: event.key,
        target: event.target?.id, repeat: event.repeat, isTrusted: event.isTrusted, wallTimeMs: performance.now() });
    });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.mountedCarId === 'lp700'
    && document.querySelector('#start-button')?.disabled === false
    && document.querySelector('#straight-line-diagnostic'), null, { timeout: 90000 });
  await page.getByRole('button', { name: '开始直线高速刹车测试', exact: true }).click();
  const startedAt = Date.now();
  while (Date.now() - startedAt < 300000) {
    result = JSON.parse(await page.locator('#straight-line-status').textContent());
    console.log(JSON.stringify(result));
    if (result.phase === 'saved' || result.phase === 'save-failed') break;
    if (result.error || errors.length) throw new Error(result.error || errors.join('\n'));
    await delay(5000);
  }
  if (result?.phase !== 'saved') throw new Error(`Recording did not save: ${JSON.stringify(result)}`);
  const keyboardEvents = await page.evaluate(() => window.__flatBrakingKeyboardAudit);
  save('keyboard-events.json', keyboardEvents);
  const run = JSON.parse(fs.readFileSync(path.join(root, result.path), 'utf8'));
  fs.copyFileSync(path.join(root, result.path), path.join(out, 'recording.json'), fs.constants.COPYFILE_EXCL);
  await page.screenshot({ path: path.join(out, 'finished.png') });
  const brakeRows = run.samples.filter(s => s.phase === 'brake');
  const accelerationRows = run.samples.filter(s => s.phase === 'accelerate');
  const first = brakeRows[0], last = brakeRows.at(-1);
  if (!first || !last) throw new Error('Missing brake samples');
  const expectedEvents = ['keydown:KeyW', 'keyup:KeyW', 'keydown:KeyS', 'keyup:KeyS'];
  const actualEvents = keyboardEvents.map(e => `${e.type}:${e.code}`);
  const sequenceMatches = JSON.stringify(expectedEvents) === JSON.stringify(actualEvents);
  const summary = {
    scope: 'Actual Chrome page, production main loop and InputController; automated DOM keyboard events (isTrusted=false). Flat TrackSystem straight; LP700 only.',
    url, outputDirectory: out, originalRecording: result.path, endReason: run.endReason,
    keySequence: actualEvents, keySequenceMatches: sequenceMatches,
    sampleCount: run.samples.length,
    physicalStepsContinuous: run.samples.every((s, i) => !i || s.fixedStepIndex === run.samples[i - 1].fixedStepIndex + 1),
    sourceUnchangedDuringRun: JSON.stringify(sourceSha256) === JSON.stringify(hashes()),
    actualInputMatchesKeys: run.samples.every(s => (s.phase !== 'accelerate' || (s.input.rawThrottle === 1 && s.input.rawBrake === 0))
      && (s.phase !== 'brake' || (s.input.rawThrottle === 0 && s.input.rawBrake === 1))),
    zeroSteeringAndHandbrake: run.samples.every(s => s.input.steer === 0 && s.input.rawHandbrake === 0),
    automaticReset: run.events.filter(e => e.type === 'automatic-reset'),
    reverseDuringBrake: brakeRows.some(s => s.vehicle?.reverse),
    accelerationSeconds: accelerationRows.length * run.fixedDt,
    speedBeforeBrakeKmh: accelerationRows.at(-1)?.body.signedSpeedKmh,
    brakeSeconds: brakeRows.length * run.fixedDt,
    maxHeadingChangeDuringBrakeDeg: Math.max(...brakeRows.map(s => Math.abs(s.body.headingChangeDeg - first.body.headingChangeDeg))),
    maxLateralDepartureDuringBrakeM: Math.max(...brakeRows.map(s => Math.abs(s.body.lateralDisplacementM - first.body.lateralDisplacementM))),
    maxYawRateDuringBrakeRadS: Math.max(...brakeRows.map(s => Math.abs(s.body.angularVelocity.y))),
    finalBrakeHorizontalKmh: last.body.speedKmh, errors,
  };
  save('summary.json', summary);
  save('metadata.json', { createdAt: new Date().toISOString(), browser: await browser.version(), sourceSha256, protocol: run.protocol });
  console.log(JSON.stringify(summary, null, 2));
  if (!sequenceMatches || !summary.actualInputMatchesKeys || !summary.physicalStepsContinuous
    || !summary.sourceUnchangedDuringRun || run.endReason !== 'STOPPED') process.exitCode = 1;
} catch (error) {
  save('failure.json', { error: error.stack, result, errors, serverLog });
  if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  console.error(error); console.error(`Saved diagnostics: ${out}`); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
}
