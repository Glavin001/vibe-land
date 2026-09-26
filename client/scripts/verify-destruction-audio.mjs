// Decode the delivered files, so checks include compression artefacts.
// Usage: node client/scripts/verify-destruction-audio.mjs [--report]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../public/audio/destruction/', import.meta.url));
const materials = ['concrete', 'stone', 'metal', 'sheet', 'wood', 'glass', 'earth'];
const required = materials.flatMap(m => [
  ...Array.from({ length: 5 }, (_, i) => `${m}-impact-${i}`),
  ...Array.from({ length: 3 }, (_, i) => `${m}-fracture-${i}`), `${m}-scrape`, `${m}-roll`,
]).concat(Array.from({ length: 4 }, (_, i) => `collapse-${i}`),
  Array.from({ length: 4 }, (_, i) => `flyby-${i}`),
  ['rifle', 'cannon'].flatMap(w => Array.from({ length: 3 }, (_, i) => `shot-${w}-${i}`)), ['air', 'rumble', 'wind'],
  materials.filter(m => m !== 'glass').map(m => `heavy-${m}`), materials.map(m => `debris-${m}`));
const failures = [];
const check = (condition, text) => { if (!condition) failures.push(text); };
const db = x => Math.round(20 * Math.log10(Math.max(1e-9, x)) * 100) / 100;
const metrics = {};
function windowLevels(samples, seconds = .2) {
  const length = Math.round(seconds * 48000), values = [];
  for (let start = 0; start + length <= samples.length; start += length) {
    let power = 0;
    for (let i = start; i < start + length; i++) power += samples[i] ** 2;
    values.push(Math.sqrt(power / length));
  }
  return values;
}
// Hann-windowed radix-2 FFT. Ratios exclude DC and are measured after delivery
// encoding; they guard against a new "heavy" layer being only sub-bass or hiss.
function spectrum(samples) {
  const n = 2048, real = new Float64Array(n), imag = new Float64Array(n);
  let total = 0, sub = 0, lowMid = 0, high = 0, weighted = 0;
  for (let start = 0; start + n <= samples.length; start += n) {
    for (let i = 0; i < n; i++) { real[i] = samples[start + i] * (.5 - .5 * Math.cos(2 * Math.PI * i / (n - 1))); imag[i] = 0; }
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
      if (i < j) [real[i], real[j]] = [real[j], real[i]];
    }
    for (let length = 2; length <= n; length *= 2) {
      const angle = -2 * Math.PI / length, wr = Math.cos(angle), wi = Math.sin(angle);
      for (let base = 0; base < n; base += length) {
        let ur = 1, ui = 0;
        for (let j = 0; j < length / 2; j++) {
          const a = base + j, b = a + length / 2, vr = real[b] * ur - imag[b] * ui, vi = real[b] * ui + imag[b] * ur;
          real[b] = real[a] - vr; imag[b] = imag[a] - vi; real[a] += vr; imag[a] += vi;
          const next = ur * wr - ui * wi; ui = ur * wi + ui * wr; ur = next;
        }
      }
    }
    for (let k = 1; k < n / 2; k++) {
      const power = real[k] ** 2 + imag[k] ** 2, frequency = k * 48000 / n;
      total += power; weighted += power * frequency;
      if (frequency < 80) sub += power;
      else if (frequency <= 1000) lowMid += power;
      if (frequency > 2000) high += power;
    }
  }
  return { subShare: +(sub / total).toFixed(4), lowMidShare: +(lowMid / total).toFixed(4), above2kShare: +(high / total).toFixed(4), centroidHz: Math.round(weighted / total) };
}
for (const [frequency, band] of [[40, 'subShare'], [440, 'lowMidShare'], [4400, 'above2kShare']]) {
  const tone = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i * 2 * Math.PI * frequency / 48000));
  check(spectrum(tone)[band] > .98, `Spectral verifier calibration failed for ${frequency} Hz`);
}
const catalogPath = path.join(root, 'catalog.json');
if (!fs.existsSync(catalogPath)) {
  console.error('FAIL: catalog.json missing; build the sound palette first.');
  process.exit(1);
}
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
check(Object.keys(catalog.clips).length === required.length, `Expected ${required.length} clips`);
let encodedBytes = 0, decodedBytes = 0;
for (const id of required) {
  const entry = catalog.clips[id];
  if (!entry) { failures.push(`Missing ${id}`); continue; }
  const file = path.join(root, path.basename(entry.url));
  if (!fs.existsSync(file)) { failures.push(`Missing file ${id}`); continue; }
  const encoded = fs.readFileSync(file);
  encodedBytes += encoded.length;
  check(createHash('sha256').update(encoded).digest('hex') === entry.sha256, `${id}: checksum mismatch`);
  const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '1', '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { maxBuffer: 8e6, timeout: 15000 });
  if (result.status !== 0) { failures.push(`${id}: decode failed (${result.error ?? result.stderr})`); continue; }
  const samples = new Float32Array(result.stdout.buffer.slice(result.stdout.byteOffset, result.stdout.byteOffset + result.stdout.length));
  decodedBytes += samples.byteLength;
  let peak = 0, square = 0, sum = 0, head = 0, tail = 0, clipped = 0, derivativeSquare = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) { failures.push(`${id}: nonfinite sample`); break; }
    peak = Math.max(peak, Math.abs(v)); square += v * v; sum += v;
    if (i > 0) derivativeSquare += (v - samples[i - 1]) ** 2;
    if (Math.abs(v) >= .99) clipped++;
    if (i < 240) head += v * v;
    if (i >= samples.length - 960) tail += v * v;
  }
  const rms = Math.sqrt(square / samples.length);
  const duration = samples.length / 48000;
  const loop = entry.loop === true;
  const boundary = Math.abs(samples[0] - samples.at(-1));
  const checksum = createHash('sha256').update(result.stdout).digest('hex');
  check(peak < .96 && clipped === 0, `${id}: insufficient decoded peak headroom (${db(peak)} dBFS)`);
  check(rms > .006 && rms < .3, `${id}: unexpected average level (${db(rms)} dBFS)`);
  check(Math.abs(sum / samples.length) < .001, `${id}: DC offset too large`);
  check(duration >= .25 && duration <= 8, `${id}: duration out of range (${duration})`);
  check(Math.abs(duration - entry.duration) < .045, `${id}: catalog duration mismatch`);
  const boundaryLimit = loop ? Math.max(.003, 5 * Math.sqrt(derivativeSquare / (samples.length - 1))) : .003;
  check(boundary < boundaryLimit, `${id}: boundary discontinuity (${boundary}, limit ${boundaryLimit})`);
  if (!loop) check(Math.sqrt(tail / 960) < .008, `${id}: abrupt tail (${db(Math.sqrt(tail / 960))} dBFS)`);
  metrics[id] = { duration: +duration.toFixed(3), peakDbfs: db(peak), rmsDbfs: db(rms), crestDb: db(peak / rms), dc: +(sum / samples.length).toFixed(7), boundaryJump: +boundary.toFixed(7), boundaryLimit: +boundaryLimit.toFixed(7), normalizedDerivativeRms: +(Math.sqrt(derivativeSquare / (samples.length - 1)) / rms).toFixed(5), tailDbfs: db(Math.sqrt(tail / 960)), encodedBytes: encoded.length, pcmSha256: checksum, loop };
  if (id.startsWith('heavy-') || id.startsWith('debris-') || id.startsWith('collapse-') || id.endsWith('-impact-0')) {
    metrics[id].spectrum = spectrum(samples);
  }
  if (id.startsWith('heavy-')) {
    const active = samples.subarray(384, 384 + 36000);
    let activePower = 0; for (const v of active) activePower += v * v;
    const activeRms = Math.sqrt(activePower / active.length);
    metrics[id].activeRmsDbfs = db(activeRms);
    check(!loop && rms >= .08 && activeRms >= .12, `${id}: heavy body is too weak (${db(rms)} dBFS full / ${db(activeRms)} dBFS active)`);
    check(metrics[id].spectrum.lowMidShare >= .38 && metrics[id].spectrum.subShare < .38 && metrics[id].spectrum.above2kShare < .2,
      `${id}: body must be broad low-mid energy, not only sub-bass or ringing (${JSON.stringify(metrics[id].spectrum)})`);
    check(db(peak / rms) >= 7, `${id}: impact transient has been flattened`);
  }
  if (id.startsWith('collapse-')) check(rms >= .08 && metrics[id].spectrum.lowMidShare >= .4 && metrics[id].spectrum.subShare < .35,
    `${id}: collapse lost sustained, speaker-audible body (${db(rms)} dBFS / ${JSON.stringify(metrics[id].spectrum)})`);
  if (id.startsWith('debris-')) {
    const levels = windowLevels(samples).sort((a, b) => a - b);
    const floor = levels[0], p10 = levels[Math.floor(levels.length * .1)];
    metrics[id].quietestWindowDbfs = db(floor); metrics[id].p10WindowDbfs = db(p10);
    check(loop && duration >= 5 && rms >= .1 && floor >= .025 && p10 >= .07,
      `${id}: sustained chaos contains weak patches (${db(rms)} dBFS full / ${db(p10)} dBFS p10 / ${db(floor)} dBFS minimum)`);
    if (id !== 'debris-glass') check(metrics[id].spectrum.lowMidShare >= .3 && metrics[id].spectrum.subShare < .38,
      `${id}: debris must retain audible low-mid body (${JSON.stringify(metrics[id].spectrum)})`);
    else check(metrics[id].spectrum.above2kShare >= .25, `${id}: glass identity lost its bright fragments`);
  }
}
for (const family of [...materials.map(m => `${m}-impact-`), ...materials.map(m => `${m}-fracture-`), 'collapse-', 'flyby-', 'shot-rifle-', 'shot-cannon-']) {
  const checksums = Object.entries(metrics).filter(([id]) => id.startsWith(family)).map(([, m]) => m.pcmSha256);
  check(new Set(checksums).size === checksums.length, `${family}: duplicate variations`);
}
for (const material of materials) {
  const roll = metrics[`${material}-roll`], scrape = metrics[`${material}-scrape`];
  if (roll && scrape) check(roll.normalizedDerivativeRms < scrape.normalizedDerivativeRms,
    `${material}: rolling must retain less high-frequency energy than scraping`);
}
for (let i = 0; i < 3; i++) {
  const rifle = metrics[`shot-rifle-${i}`], cannon = metrics[`shot-cannon-${i}`];
  if (rifle && cannon) {
    check(rifle.duration < .8 && cannon.duration > 1, `shot ${i}: rifle/cannon duration distinction lost`);
    check(cannon.normalizedDerivativeRms < rifle.normalizedDerivativeRms, `shot ${i}: cannon should have a deeper spectrum than rifle`);
  }
}
check(encodedBytes < 16 * 1024 ** 2, `Download exceeds 16 MiB: ${encodedBytes}`);
check(decodedBytes < 64 * 1024 ** 2, `PCM bank exceeds 64 MiB: ${decodedBytes}`);
const report = { schema: 2, generatedAt: new Date().toISOString(), passed: failures.length === 0, clipCount: Object.keys(metrics).length, encodedBytes, decodedBytes, limits: { downloadMiB: 16, pcmMiB: 64, peakDbfs: db(.96), minimumRmsDbfs: db(.006), maximumDurationSeconds: 8 }, failures, clips: metrics };
if (process.argv.includes('--report')) fs.writeFileSync(path.join(root, 'quality-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`${failures.length ? 'FAIL' : 'PASS'}: ${report.clipCount} clips; ${(encodedBytes / 1024 ** 2).toFixed(2)} MiB download; ${(decodedBytes / 1024 ** 2).toFixed(2)} MiB decoded PCM`);
for (const message of failures) console.error(`  ${message}`);
process.exitCode = failures.length ? 1 : 0;
