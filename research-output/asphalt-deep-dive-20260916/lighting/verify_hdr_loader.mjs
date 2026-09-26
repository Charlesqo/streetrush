// Independent decoder cross-check against the project's actual r180 loader.
// Parses files only; no renderer, browser, attachment script, or game mutation.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { HDRLoader } from '../../../node_modules/three/examples/jsm/loaders/HDRLoader.js';
const summary = JSON.parse(fs.readFileSync(new URL('./hdr-analysis.json', import.meta.url), 'utf8'));
const bytes = fs.readFileSync(summary.source);
const parsed = new HDRLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const sha = crypto.createHash('sha256').update(Buffer.from(parsed.data.buffer)).digest('hex');
assert.deepEqual([parsed.width, parsed.height], summary.dimensions);
assert.equal(sha, summary.runtime_half_rgba_sha256);
console.log(JSON.stringify({status:'PASS_CPU_DECODER_BYTE_FOR_BYTE', width:parsed.width, height:parsed.height, halfRgbaSha256:sha}, null, 2));
