// 只读审计脚本：读取 public/audio-banks 六个车型的 bank.json，
// 校验其引用的 WAV 是否存在、解析 RIFF/WAVE 头、计算 sha256。
// 不写任何 audio-banks 文件；产物仅写入本 scratch 目录。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';

const ROOT = '/Volumes/Storage/streetrush/public/audio-banks';
const OUT = '/Volumes/Storage/streetrush/scratch/glm-audio-20260905-084910';
const CARS = ['mx5', 'm3e30', 'gt3rs', 'lp700', 'amggt3', 'm5g90'];

function parseWav(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    return { headerOk: false, reason: 'not RIFF/WAVE' };
  }
  let off = 12;
  let fmt = null;
  let dataBytes = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        audioFormat: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      dataBytes = size;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || dataBytes == null) return { headerOk: false, reason: 'missing fmt/data chunk' };
  const bytesPerFrame = (fmt.bitsPerSample / 8) * fmt.channels;
  const duration = dataBytes / bytesPerFrame / fmt.sampleRate;
  const formatName = fmt.audioFormat === 1 ? 'PCM16-WAV' : `fmt-${fmt.audioFormat}`;
  return {
    headerOk: true,
    container: 'RIFF/WAVE',
    audioFormat: fmt.audioFormat,
    formatName,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    dataBytes,
    durationSeconds: Math.round(duration * 1000) / 1000,
  };
}

const audit = {
  generatedAtLocal: new Date().toString(),
  readOnlyRoot: ROOT,
  note: '仅基于 public/audio-banks/ 的 bank.json 与其实际引用文件；未修改任何源文件。',
  cars: [],
};

for (const car of CARS) {
  const dir = join(ROOT, car);
  const bankPath = join(dir, 'bank.json');
  const bank = JSON.parse(readFileSync(bankPath, 'utf8'));
  const diskFiles = readdirSync(dir).filter((f) => f !== 'bank.json');

  const layers = (bank.layers ?? []).map((l) => {
    const p = join(dir, l.file);
    let entry = {
      rpm: l.rpm,
      load: l.load,
      mode: l.mode,
      file: l.file,
      loop: l.loop ?? null,
      existsOnDisk: false,
    };
    try {
      const buf = readFileSync(p);
      entry.existsOnDisk = true;
      entry.bytes = buf.length;
      entry.sha256 = createHash('sha256').update(buf).digest('hex');
      entry.wav = parseWav(buf);
    } catch (err) {
      entry.error = String(err && err.code ? err.code : err);
    }
    return entry;
  });

  const referenced = new Set((bank.layers ?? []).map((l) => l.file));
  const unreferencedOnDisk = diskFiles.filter((f) => !referenced.has(f));
  const missing = layers.filter((l) => !l.existsOnDisk).map((l) => l.file);

  audit.cars.push({
    car,
    bankPathOnDisk: bankPath,
    bank,
    layerCheck: {
      referencedCount: layers.length,
      presentCount: layers.filter((l) => l.existsOnDisk).length,
      missingFiles: missing,
      unreferencedFilesOnDisk: unreferencedOnDisk,
    },
    layers,
  });
}

writeFileSync(join(OUT, 'audit-inventory.json'), JSON.stringify(audit, null, 2));

// 供试听页使用的 data.js（页面经 <script src> 加载，file:// 下不走 fetch）
const slim = {
  generatedAtLocal: audit.generatedAtLocal,
  readOnlyRoot: ROOT,
  audioUrlPrefix: '../../public/audio-banks',
  cars: audit.cars.map(({ car, bank, layerCheck, layers }) => ({
    car,
    bankId: bank.id,
    version: bank.version,
    family: bank.family,
    scope: bank.scope,
    format: { sampleRate: bank.sampleRate, channels: bank.channels, format: bank.format, durationSeconds: bank.durationSeconds, quality: bank.quality },
    loop: bank.loop ?? null,
    source: bank.source ?? null,
    registration: bank.registration ?? null,
    selection: bank.selection ?? null,
    compatibilityOverlay: bank.compatibilityOverlay ?? null,
    layerCheck,
    layers: layers.map(({ rpm, load, mode, file, existsOnDisk, bytes, sha256, wav }) => ({
      rpm, load, mode, file, existsOnDisk, bytes, sha256, wav,
    })),
  })),
};
writeFileSync(join(OUT, 'data.js'), 'window.STREETRUSH_AUDIT = ' + JSON.stringify(slim, null, 2) + ';\n');

// 人类可读摘要
const lines = [];
for (const c of audit.cars) {
  lines.push(`## ${c.car} — ${c.bank.id}`);
  lines.push(`- 层: ${c.layerCheck.presentCount}/${c.layerCheck.referencedCount} 在盘; 缺失: ${c.layerCheck.missingFiles.length ? c.layerCheck.missingFiles.join(', ') : '无'}; 盘上未引用: ${c.layerCheck.unreferencedFilesOnDisk.length ? c.layerCheck.unreferencedFilesOnDisk.join(', ') : '无'}`);
  for (const l of c.layers) {
    const w = l.wav && l.wav.headerOk ? `${l.wav.formatName} ${l.wav.sampleRate}Hz ${l.wav.channels}ch ${l.wav.bitsPerSample}bit ${l.wav.durationSeconds}s` : `头解析失败: ${l.wav && l.wav.reason}`;
    lines.push(`  - ${l.file}: ${l.existsOnDisk ? `${l.bytes}B sha256=${l.sha256.slice(0, 12)}… ${w}` : '缺失'}`);
  }
  lines.push('');
}
writeFileSync(join(OUT, 'audit-summary.md'), `# audio-banks 只读审计摘要\n\n${lines.join('\n')}`);
console.log(lines.join('\n'));
