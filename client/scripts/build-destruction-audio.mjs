// Deterministic palette: CC0 Kenney Foley + original procedural layers.
// node client/scripts/build-destruction-audio.mjs /path/to/Kenney/Audio /path/to/Breaking
// node client/scripts/build-destruction-audio.mjs --fetch
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ARCHIVE = 'https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip';
const ARCHIVE_SHA256 = '029d734af1582474edf3a694d1b0cebc97c1c152f2f39fa34d4c2bafc5de77f8';
const BREAKING_ARCHIVE = 'https://opengameart.org/sites/default/files/sfx_breaking_and_falling.zip';
const BREAKING_SHA256 = 'e6ee04d91c5f4d30cfda1260d2c9d1faf96fda36319287215fbd07bcb1a80451';
const sha = data => createHash('sha256').update(data).digest('hex');
let source = process.argv[2];
let breakingSource = process.argv[3];
async function fetchArchive(url, checksum, cache, fileName) {
  fs.mkdirSync(cache, { recursive: true });
  const archivePath = path.join(cache, fileName);
  if (!fs.existsSync(archivePath) || sha(fs.readFileSync(archivePath)) !== checksum) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Source download: ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (sha(archive) !== checksum) throw new Error('Source archive checksum mismatch; source has changed');
    fs.writeFileSync(archivePath, archive);
  }
  const unzip = spawnSync('unzip', ['-oq', archivePath, '-d', cache], { timeout: 15000 });
  if (unzip.status !== 0) throw new Error(String(unzip.stderr));
}
if (source === '--fetch') {
  const cache = path.join(os.tmpdir(), 'vibe-destruction-audio-cc0');
  await fetchArchive(ARCHIVE, ARCHIVE_SHA256, cache, 'kenney-impact-sounds.zip');
  source = path.join(cache, 'Audio');
  breakingSource = path.join(cache, 'breaking');
  await fetchArchive(BREAKING_ARCHIVE, BREAKING_SHA256, breakingSource, 'breaking.zip');
}
if (!source || !fs.existsSync(source) || !breakingSource || !fs.existsSync(breakingSource)) throw new Error('Pass extracted Kenney Audio and rubberduck Breaking directories, or --fetch for checksum-pinned downloads');
const out = fileURLToPath(new URL('../public/audio/destruction/', import.meta.url));
fs.mkdirSync(out, { recursive: true });
const rate = 48000;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-audio-render-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
const decoded = new Map(), sourceHashes = {};
const randomFor = id => {
  let seed = parseInt(sha(id).slice(0, 8), 16) >>> 0;
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
};
function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '1', ...args], { maxBuffer: 32e6, timeout: 20000 });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}
function read(name, external = false) {
  const key = `${external ? 'rubberduck' : 'kenney'}/${name}`;
  if (decoded.has(key)) return decoded.get(key);
  const file = path.join(external ? breakingSource : source, name + '.ogg');
  sourceHashes[key + '.ogg'] = sha(fs.readFileSync(file));
  const rawPath = path.join(scratch, 'decoded.f32');
  ffmpeg(['-y', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', rawPath]);
  const bytes = fs.readFileSync(rawPath);
  const raw = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  // Remove recorded leading silence without removing the contact attack.
  let first = 0, last = raw.length - 1;
  while (first < last && Math.abs(raw[first]) < .003) first++;
  while (last > first && Math.abs(raw[last]) < .0008) last--;
  const a = raw.slice(Math.max(0, first - 48), Math.min(raw.length, last + 480));
  decoded.set(key, a);
  return a;
}
function add(dest, src, start, gain = 1, speed = 1) {
  if (!(speed > 0) || !Number.isFinite(speed)) throw new Error('Invalid playback speed');
  const base = Math.round(start * rate);
  const count = Math.min(dest.length - base, Math.floor((src.length - 1) / speed));
  for (let i = Math.max(0, -base); i < count; i++) {
    const p = i * speed, n = Math.floor(p), f = p - n;
    dest[base + i] += gain * (src[n] * (1 - f) + src[n + 1] * f);
  }
}
const recording = (prefix, variant) => read(`${prefix}_${String(variant % 5).padStart(3, '0')}`);
const breaking = (kind, variant, variants = 3) => read(`bfh1_${kind}_${String(variant % variants + 1).padStart(2, '0')}`, true);
function body(a, frequencies, gain, decay, random) {
  const phases = frequencies.map(() => random() * .2);
  for (let i = 0; i < Math.min(a.length, rate * decay * 7); i++) {
    const t = i / rate, attack = Math.min(1, t / .0025);
    for (let j = 0; j < frequencies.length; j++)
      a[i] += Math.sin(t * frequencies[j] * Math.PI * 2 + phases[j]) * gain / (j + 1) * Math.exp(-t * (j + 1) / decay) * attack;
  }
}
function noise(a, random, { low = 100, high = 1800, gain = .1, decay = 1, rise = .005, sustained = false } = {}) {
  let lp = 0, hp = 0, movement = 0;
  const highA = 1 - Math.exp(-2 * Math.PI * high / rate), lowA = 1 - Math.exp(-2 * Math.PI * low / rate);
  for (let i = 0; i < a.length; i++) {
    const t = i / rate, x = random() * 2 - 1;
    lp += highA * (x - lp); hp += lowA * (lp - hp);
    movement += .00011 * (random() * 2 - 1 - movement);
    const envelope = sustained ? .77 + .13 * Math.sin(t * 4.3) + Math.min(.1, movement * 4) : Math.min(1, t / rise) * Math.exp(-t / decay);
    a[i] += (lp - hp) * gain * envelope;
  }
}
function bandLimit(input, low, high) {
  const a = new Float32Array(input.length);
  const highA = 1 - Math.exp(-2 * Math.PI * high / rate), lowA = 1 - Math.exp(-2 * Math.PI * low / rate);
  let lp1 = 0, lp2 = 0, hp = 0;
  for (let i = 0; i < input.length; i++) {
    lp1 += highA * (input[i] - lp1); lp2 += highA * (lp1 - lp2); hp += lowA * (lp2 - hp);
    a[i] = lp2 - hp;
  }
  return a;
}
function thicken(a, threshold = .62) {
  // Smooth compression adds audible body/harmonics while retaining a transient;
  // it prevents one tiny, sharp sample from setting the whole texture's level.
  for (let i = 0; i < a.length; i++) a[i] = threshold * Math.tanh(a[i] / threshold);
}
function seamless(a) {
  // Crossfade the stationary texture into its beginning. The join connects
  // adjacent source samples, preserving a continuous texture across repeats.
  const n = 4800, result = new Float32Array(a.length - n);
  result.set(a.subarray(n, a.length));
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1), k = result.length - n + i;
    result[k] = a[a.length - n + i] * Math.cos(f * Math.PI / 2) + a[i] * Math.sin(f * Math.PI / 2);
  }
  return result;
}
const catalog = {};
function write(id, input, { peak = .74, rms = .09, loop = false } = {}) {
  let a = loop ? seamless(input) : input;
  // DC/high-pass cleanup preserves transient contrast. RMS is an upper target,
  // while the peak cap takes precedence; quiet tails stay quiet.
  let dc = 0, maximum = 0, squares = 0;
  const alpha = 1 - Math.exp(-2 * Math.PI * 18 / rate);
  // Warm the high-pass filter around one period to avoid a loop-start transient.
  if (loop) for (const sample of a) dc += alpha * (sample - dc);
  const fadeIn = 48, fadeOut = 1440;
  for (let i = 0; i < a.length; i++) {
    dc += alpha * (a[i] - dc);
    a[i] = (a[i] - dc) * (loop ? 1 : Math.min(1, i / fadeIn, (a.length - 1 - i) / fadeOut));
    maximum = Math.max(maximum, Math.abs(a[i])); squares += a[i] * a[i];
  }
  const gain = Math.min(peak / Math.max(maximum, .001), rms / Math.max(Math.sqrt(squares / a.length), .0001));
  for (let i = 0; i < a.length; i++) a[i] *= gain;
  // MP3 can smear a sharp transient back into sample zero. Eight milliseconds
  // of guard silence prevents a decode-edge click while retaining fast onset.
  if (!loop) { const padded = new Float32Array(a.length + 768); padded.set(a, 384); a = padded; }
  // Lossless PCM loops preserve joins exactly; one-shot files use compact MP3.
  const filename = id + (loop ? '.wav' : '.mp3');
  const rawPath = path.join(scratch, 'input.f32');
  fs.writeFileSync(rawPath, Buffer.from(a.buffer));
  const codec = loop ? ['-codec:a', 'pcm_s16le'] : ['-codec:a', 'libmp3lame', '-b:a', '128k'];
  ffmpeg(['-y', '-f', 'f32le', '-ar', String(rate), '-ac', '1', '-i', rawPath, '-map_metadata', '-1', ...codec, path.join(out, filename)]);
  const stale = path.join(out, id + (loop ? '.mp3' : '.wav'));
  if (fs.existsSync(stale)) fs.unlinkSync(stale);
  catalog[id] = { url: '/audio/destruction/' + filename, duration: a.length / rate, loop, sha256: sha(fs.readFileSync(path.join(out, filename))) };
  console.log(`Built ${id}`);
}
const materials = {
  concrete: { heavy: 'impactMining', light: 'footstep_concrete', pitch: .68, modes: [83, 167, 297], resonance: .11, friction: [140, 3700] },
  stone: { heavy: 'impactMining', light: 'impactGeneric_light', pitch: .94, modes: [137, 348, 593], resonance: .08, friction: [330, 5500] },
  metal: { heavy: 'impactMetal_heavy', light: 'impactMetal_light', pitch: .83, modes: [188, 491, 907], resonance: .3, friction: [800, 6400] },
  sheet: { heavy: 'impactPlate_heavy', light: 'impactTin_medium', pitch: .76, modes: [121, 323, 671], resonance: .37, friction: [480, 4200] },
  wood: { heavy: 'impactWood_heavy', light: 'impactPlank_medium', pitch: .82, modes: [106, 241, 557], resonance: .065, friction: [260, 2800] },
  glass: { heavy: 'impactGlass_heavy', light: 'impactGlass_light', pitch: 1.04, modes: [1741, 3293, 5233], resonance: .14, friction: [1600, 9000] },
  earth: { heavy: 'impactSoft_heavy', light: 'footstep_grass', pitch: .75, modes: [58, 129, 267], resonance: .05, friction: [100, 2200] },
};
for (const [material, p] of Object.entries(materials)) {
  for (let v = 0; v < 5; v++) {
    const id = `${material}-impact-${v}`, random = randomFor(id);
    const a = new Float32Array(Math.round(rate * (material === 'metal' || material === 'sheet' ? 1.9 : 1.6)));
    add(a, recording(p.heavy, v), 0, .87, p.pitch * (.97 + random() * .06));
    add(a, recording(p.light, (v + 2) % 5), .012 + random() * .008, material === 'earth' ? .4 : .23, 1.02);
    body(a, p.modes.map(f => f * (.97 + random() * .06)), material === 'glass' ? .024 : .065, p.resonance, random);
    if (material === 'concrete' || material === 'earth') noise(a, random, { low: 65, high: 1800, gain: .07, decay: .14 });
    write(id, a);
  }
  for (let v = 0; v < 3; v++) {
    const id = `${material}-fracture-${v}`, random = randomFor(id), a = new Float32Array(Math.round(rate * 2.8));
    const fractureKind = material === 'glass' ? 'glass_breaking' : material === 'wood' ? 'wood_breaking'
      : material === 'metal' || material === 'sheet' ? 'metal_falling' : 'rock_breaking';
    add(a, breaking(fractureKind, v), 0, .68, material === 'concrete' ? .75 : material === 'earth' ? .62 : p.pitch);
    add(a, recording(p.heavy, v), .008, .3, p.pitch * .92);
    for (let j = 0; j < 25; j++) {
      const t = .018 + Math.pow(random(), 1.7) * 2.26;
      add(a, recording(j % 5 === 0 ? p.heavy : p.light, Math.floor(random() * 5)), t,
        (.035 + random() * .16) * Math.exp(-t * 1.1), p.pitch * (.63 + random() * .84));
    }
    noise(a, random, { low: p.friction[0], high: p.friction[1], gain: material === 'earth' ? .32 : .12, decay: .29, rise: .012 });
    body(a, p.modes, .045, p.resonance * 1.4, random);
    write(id, a, { peak: .77, rms: .083 });
  }
  const id = `${material}-scrape`, random = randomFor(id), a = new Float32Array(Math.round(rate * 5.1));
  noise(a, random, { low: p.friction[0], high: p.friction[1], gain: .34, sustained: true });
  // Closely spaced short grains make continuous stick-slip friction, with sparse
  // source contacts retaining the surface's recognisable Foley character.
  for (let j = 0; j < 100; j++) {
    const clip = recording(p.light, Math.floor(random() * 5));
    const grainLength = Math.min(clip.length, Math.round(rate * (.018 + random() * .07)));
    const grain = new Float32Array(grainLength), offset = Math.floor(random() * Math.max(1, clip.length - grainLength));
    for (let i = 0; i < grainLength; i++) grain[i] = clip[offset + i] * Math.sin(Math.PI * i / grainLength) ** 2;
    add(a, grain, random() * 5, .12 + random() * .15, .75 + random() * .5);
  }
  for (let j = 0; j < 12; j++) add(a, recording(p.light, j % 5), random() * 4.8, .025, .63 + random() * .6);
  write(id, a, { peak: .48, rms: .06, loop: true });

  const rollId = `${material}-roll`, rollRandom = randomFor(rollId), roll = new Float32Array(Math.round(rate * 3.7));
  noise(roll, rollRandom, { low: 35, high: material === 'glass' ? 1500 : 600, gain: .35, sustained: true });
  let nextContact = .015;
  for (let j = 0; nextContact < 3.65; j++) {
    const clip = recording(p.light, Math.floor(rollRandom() * 5));
    const length = Math.min(clip.length, Math.round(rate * (.026 + rollRandom() * .08)));
    const grain = new Float32Array(length);
    for (let i = 0; i < length; i++) grain[i] = clip[i] * Math.min(1, i / 144) * Math.exp(-i / (length * .3));
    // Irregular low contacts suggest tumbling/revolutions, rather than a steady
    // friction hiss. A little metal/glass resonance survives in the source grain.
    add(roll, grain, nextContact, .18 + rollRandom() * .35, .43 + rollRandom() * .32);
    nextContact += .048 + rollRandom() * .13;
  }
  write(rollId, roll, { peak: .49, rms: .055, loop: true });
}
for (const [material, p] of Object.entries(materials)) {
  const fractureKind = material === 'glass' ? 'glass_breaking' : material === 'wood' ? 'wood_breaking'
    : material === 'metal' || material === 'sheet' ? 'metal_falling' : 'rock_breaking';
  if (material !== 'glass') {
    const id = `heavy-${material}`, random = randomFor(id), a = new Float32Array(Math.round(rate * 2.2));
    // This layer supplies slab/chassis-sized weight in ordinary speakers. Most
    // energy is 80–1000 Hz, with only supporting sub-bass and restrained ring.
    noise(a, random, { low: 88, high: material === 'earth' ? 670 : 1050, gain: 3.4, decay: .51, rise: .003 });
    noise(a, random, { low: 43, high: 220, gain: 1.2, decay: .42, rise: .004 });
    body(a, p.modes.map(f => Math.max(104, Math.min(790, f * .7))), .13, material === 'wood' ? .13 : .24, random);
    add(a, bandLimit(recording(p.heavy, 2), 65, 1550), 0, .6, material === 'sheet' ? .43 : .52);
    add(a, bandLimit(breaking(fractureKind, 1), 80, 1900), .013, .46, material === 'earth' ? .53 : .65);
    for (let j = 0; j < 8; j++) {
      const at = .05 + random() * .72;
      add(a, bandLimit(recording(p.heavy, j % 5), 95, 1250), at, .13 * Math.exp(-at), .38 + random() * .27);
    }
    thicken(a, .62);
    const weighted = bandLimit(a, 45, 1450);
    thicken(weighted, .22);
    write(id, weighted, { peak: .79, rms: .15 });
  }

  const id = `debris-${material}`, random = randomFor(id), a = new Float32Array(Math.round(rate * 6.5));
  const glass = material === 'glass';
  noise(a, random, { low: glass ? 500 : 92, high: glass ? 6500 : material === 'earth' ? 700 : 1050,
    gain: glass ? .35 : 1.35, sustained: true });
  // Many overlapping recorded fractures/contacts form an extended destruction
  // region. Its envelope stays alive throughout the loop, unlike impact tails.
  for (let j = 0; j < 132; j++) {
    const src = j % 3 === 0 ? breaking(fractureKind, Math.floor(random() * 3))
      : recording(j % 2 ? p.heavy : p.light, Math.floor(random() * 5));
    const length = Math.min(src.length, Math.round(rate * (.08 + random() * .24)));
    const grain = new Float32Array(length), offset = Math.floor(random() * Math.max(1, src.length - length) * .6);
    for (let i = 0; i < length; i++) grain[i] = src[offset + i] * Math.min(1, i / 96, (length - 1 - i) / 480);
    add(a, bandLimit(grain, glass ? 700 : 75, glass ? 9500 : material === 'metal' || material === 'sheet' ? 1750 : 2400),
      random() * 6.45, .18 + random() * .35, glass ? .79 + random() * .49 : .35 + random() * .58);
  }
  const phase = random() * Math.PI * 2;
  for (let i = 0; i < a.length; i++) {
    const t = i / rate;
    a[i] *= .79 + .13 * Math.sin(t * .71 + phase) + .08 * Math.sin(t * 2.31 + phase * .67);
  }
  thicken(a, .49);
  write(id, bandLimit(a, glass ? 250 : 60, glass ? 8000 : 2200), { peak: .74, rms: .145, loop: true });
}
for (let v = 0; v < 4; v++) {
  const id = 'collapse-' + v, random = randomFor(id), a = new Float32Array(Math.round(rate * 4.8));
  noise(a, random, { low: 25, high: 230, gain: 1.5, decay: .67, rise: .006 });
  noise(a, random, { low: 92, high: 1400, gain: 2.1, decay: .73, rise: .004 });
  noise(a, random, { low: 100, high: 3800, gain: .35, decay: .19, rise: .002 });
  body(a, [81 + v * 3, 173 + v * 5, 347], .24, .32, random);
  add(a, recording('impactMining', v), 0, .67, .49 + random() * .07);
  add(a, breaking('rock_breaking', v), .025, .38, .61 + random() * .15);
  add(a, breaking('rock_falling', v, 9), .33, .21, .73);
  for (let j = 0; j < 39; j++) {
    const t = .035 + Math.pow(random(), 1.4) * 3.15;
    add(a, recording(j % 3 ? 'impactMining' : 'footstep_concrete', j % 5), t,
      (.025 + random() * .13) * Math.exp(-t * .57), .4 + random() * .7);
  }
  thicken(a, .56);
  const weighted = bandLimit(a, 45, 2300);
  thicken(weighted, .11);
  write(id, weighted, { peak: .79, rms: .135 });
}
for (const [id, low, high, gain] of [['air', 120, 2600, .8], ['rumble', 23, 165, 2], ['wind', 55, 800, 1]]) {
  const a = new Float32Array(Math.round(rate * 6.1));
  noise(a, randomFor(id), { low, high, gain, sustained: true });
  write(id, a, { peak: .46, rms: id === 'rumble' ? .065 : .055, loop: true });
}
for (let v = 0; v < 4; v++) {
  const id = 'flyby-' + v, random = randomFor(id), a = new Float32Array(Math.round(rate * 1.15));
  noise(a, random, { low: 180, high: 6000 - v * 600, gain: 1, sustained: true });
  let phase = 0;
  for (let i = 0; i < a.length; i++) {
    const t = i / rate, center = .22 + v * .015, width = .10 + v * .015;
    const envelope = Math.exp(-Math.pow((t - center) / width, 2));
    phase += 2 * Math.PI * (260 + v * 70 + 860 * Math.exp(-t * 8)) / rate;
    a[i] = (a[i] + Math.sin(phase) * .015) * envelope;
  }
  write(id, a, { peak: .69, rms: .09 });
}
for (const weapon of ['rifle', 'cannon']) for (let v = 0; v < 3; v++) {
  const id = `shot-${weapon}-${v}`, random = randomFor(id), cannon = weapon === 'cannon';
  const a = new Float32Array(Math.round(rate * (cannon ? 1.7 : .55)));
  // Separate muzzle report, pressure/body, and mechanism layers. Environment
  // reflections remain the renderer's job so these work indoors and outdoors.
  noise(a, random, { low: cannon ? 170 : 550, high: cannon ? 7000 : 11000, gain: cannon ? 1.9 : 2.5, decay: cannon ? .034 : .013, rise: .0005 });
  noise(a, random, { low: cannon ? 25 : 100, high: cannon ? 500 : 2000, gain: cannon ? 2 : .65, decay: cannon ? .2 : .039, rise: .0015 });
  body(a, cannon ? [57 + v * 2, 119, 237] : [169 + v * 7, 419, 981], cannon ? .42 : .19, cannon ? .11 : .022, random);
  add(a, recording(cannon ? 'impactMetal_heavy' : 'impactMetal_light', v), cannon ? .013 : .018, cannon ? .095 : .055, cannon ? .79 : 1.65);
  write(id, a, { peak: .79, rms: cannon ? .098 : .075 });
}
const generatorSha256 = sha(fs.readFileSync(fileURLToPath(import.meta.url)));
fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify({ version: 3, sampleRate: rate, generatorSha256, sources: {
  kenney: { page: 'https://kenney.nl/assets/impact-sounds', license: 'CC0-1.0', archiveUrl: ARCHIVE, archiveSha256: ARCHIVE_SHA256 },
  rubberduck: { page: 'https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx', license: 'CC0-1.0', archiveUrl: BREAKING_ARCHIVE, archiveSha256: BREAKING_SHA256 },
}, clips: catalog }, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'source-files.json'), JSON.stringify({ archives: { kenney: ARCHIVE_SHA256, rubberduck: BREAKING_SHA256 }, files: sourceHashes }, null, 2) + '\n');
console.log(`Built ${Object.keys(catalog).length} clips in ${out}`);
