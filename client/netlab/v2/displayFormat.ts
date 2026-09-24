// VLDISP01: what the client stage says the production client would have
// drawn, per frame. Written by clientStage.mts, read by the Rust scorer
// (server/src/bin/netlab2/score.rs).
//
// Little-endian. Magic `VLDISP01`; u32 header length; JSON header; frames:
//   [f64 tMs][f64 sampleMs][f64 offsetUs][f32 interpDelayMs][f32 dynDelayMs]
//   [f64 renderUs][f64 dynRenderUs][u32 n]
//   n x [u8 kind][u8 flags][u32 id][f32 pos x3][f32 quat xyzw][f32 ageMs]
// Times are the recording page's clock (tape ms + clockOriginMs). tMs is the
// recorded frame's time (when the live clock probe ran); sampleMs is when the
// frame's entities were drawn (the frame's start: tMs - its CPU time for
// recorded frames). offsetUs is the probe's server-time offset at tMs.
// kind: 1 player, 2 vehicle, 3 body, 4 meteor (flags = source).
// flags bit0: drawn from an interpolated sample (else the latest state);
// ageMs: how old the newest server sample behind it is (NaN if unknown).

export const DISPLAY_MAGIC = 'VLDISP01';
export const KIND_PLAYER = 1;
export const KIND_VEHICLE = 2;
export const KIND_BODY = 3;
export const FLAG_SAMPLED = 1;
export const FRAME_HEADER_BYTES = 8 + 8 + 8 + 4 + 4 + 8 + 8 + 4;
export const ENTITY_BYTES = 1 + 1 + 4 + 12 + 16 + 4;

export interface DisplayedEntity {
  kind: number;
  flags: number;
  id: number;
  position: ArrayLike<number>;
  quaternion: ArrayLike<number>;
  ageMs: number;
}

export interface DisplayedFrame {
  tMs: number;
  sampleMs: number;
  offsetUs: number;
  interpDelayMs: number;
  dynDelayMs: number;
  renderUs: number;
  dynRenderUs: number;
  entities: DisplayedEntity[];
}

export function encodeDisplayHeader(header: Record<string, unknown>): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + 4 + json.length);
  for (let i = 0; i < 8; i += 1) out[i] = DISPLAY_MAGIC.charCodeAt(i);
  new DataView(out.buffer).setUint32(8, json.length, true);
  out.set(json, 12);
  return out;
}

export function encodeDisplayFrame(frame: DisplayedFrame): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + frame.entities.length * ENTITY_BYTES);
  const view = new DataView(out.buffer);
  let at = 0;
  view.setFloat64(at, frame.tMs, true); at += 8;
  view.setFloat64(at, frame.sampleMs, true); at += 8;
  view.setFloat64(at, frame.offsetUs, true); at += 8;
  view.setFloat32(at, frame.interpDelayMs, true); at += 4;
  view.setFloat32(at, frame.dynDelayMs, true); at += 4;
  view.setFloat64(at, frame.renderUs, true); at += 8;
  view.setFloat64(at, frame.dynRenderUs, true); at += 8;
  view.setUint32(at, frame.entities.length, true); at += 4;
  for (const entity of frame.entities) {
    view.setUint8(at, entity.kind); at += 1;
    view.setUint8(at, entity.flags); at += 1;
    view.setUint32(at, entity.id, true); at += 4;
    for (let k = 0; k < 3; k += 1) { view.setFloat32(at, entity.position[k], true); at += 4; }
    for (let k = 0; k < 4; k += 1) { view.setFloat32(at, entity.quaternion[k] ?? 0, true); at += 4; }
    view.setFloat32(at, entity.ageMs, true); at += 4;
  }
  return out;
}

/** Reads a whole VLDISP01 buffer (tests and tools). */
export function decodeDisplay(bytes: Uint8Array): { header: Record<string, unknown>; frames: DisplayedFrame[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== DISPLAY_MAGIC) throw new Error(`not a ${DISPLAY_MAGIC} stream (${magic})`);
  const headerLength = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLength)));
  let at = 12 + headerLength;
  const frames: DisplayedFrame[] = [];
  while (at + FRAME_HEADER_BYTES <= bytes.length) {
    const frame: DisplayedFrame = {
      tMs: view.getFloat64(at, true),
      sampleMs: view.getFloat64(at + 8, true),
      offsetUs: view.getFloat64(at + 16, true),
      interpDelayMs: view.getFloat32(at + 24, true),
      dynDelayMs: view.getFloat32(at + 28, true),
      renderUs: view.getFloat64(at + 32, true),
      dynRenderUs: view.getFloat64(at + 40, true),
      entities: [],
    };
    const n = view.getUint32(at + 48, true);
    at += FRAME_HEADER_BYTES;
    for (let i = 0; i < n; i += 1) {
      const position = [view.getFloat32(at + 6, true), view.getFloat32(at + 10, true), view.getFloat32(at + 14, true)];
      const quaternion = [
        view.getFloat32(at + 18, true),
        view.getFloat32(at + 22, true),
        view.getFloat32(at + 26, true),
        view.getFloat32(at + 30, true),
      ];
      frame.entities.push({
        kind: view.getUint8(at),
        flags: view.getUint8(at + 1),
        id: view.getUint32(at + 2, true),
        position,
        quaternion,
        ageMs: view.getFloat32(at + 34, true),
      });
      at += ENTITY_BYTES;
    }
    frames.push(frame);
  }
  return { header, frames };
}

export interface FrameTime {
  /** When the frame's entities are drawn (the live frame's start). */
  sampleMs: number;
  /** When the frame is recorded (the live clock probe; the tape's frame time). */
  probeMs: number;
}

/**
 * The render frames the stage samples at: the recorded client's own frames
 * (its cadence, its hitches -- drawn at the frame's start, `probe - cpu`,
 * probed at its recorded time), or a fixed rate over the same span.
 */
export function frameSchedule(
  mode: string,
  recordedTimes: ArrayLike<number> | null,
  startMs: number,
  endMs: number,
  recordedCpuMs: ArrayLike<number> | null = null,
): FrameTime[] {
  if (mode === 'recorded') {
    if (!recordedTimes || recordedTimes.length === 0) {
      throw new Error('--frames recorded: the tape has no frame samples');
    }
    const out: FrameTime[] = [];
    for (let i = 0; i < recordedTimes.length; i += 1) {
      const probeMs = recordedTimes[i];
      // `recordedCpuMs` is the shift from probe to draw (negative: the draw
      // comes after the probe).
      const cpu = recordedCpuMs ? recordedCpuMs[i] : 0;
      const sampleMs = probeMs - (Number.isFinite(cpu) ? cpu : 0);
      if (Math.min(sampleMs, probeMs) >= startMs && Math.max(sampleMs, probeMs) <= endMs) {
        out.push({ sampleMs, probeMs });
      }
    }
    return out;
  }
  const hz = Number(mode);
  if (!(hz > 0)) throw new Error(`--frames ${mode}: recorded|<hz>`);
  const out: FrameTime[] = [];
  for (let t = startMs; t <= endMs; t += 1000 / hz) out.push({ sampleMs: t, probeMs: t });
  return out;
}

/** Merges packet arrivals and frames into one ordered event list: packets
 * at equal time go before the frame (the live client handles network tasks
 * before the animation frame that follows them). */
export function eventOrder(packetTimes: ArrayLike<number>, frameTimes: ArrayLike<number>): Array<['p' | 'f', number]> {
  const out: Array<['p' | 'f', number]> = [];
  let p = 0;
  let f = 0;
  while (p < packetTimes.length || f < frameTimes.length) {
    if (f >= frameTimes.length || (p < packetTimes.length && packetTimes[p] <= frameTimes[f])) {
      out.push(['p', p]);
      p += 1;
    } else {
      out.push(['f', f]);
      f += 1;
    }
  }
  return out;
}
