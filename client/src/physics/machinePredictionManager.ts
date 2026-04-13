import type { WasmSimWorldInstance } from '../wasm/sharedPhysics';
import type { InputCmd, NetSnapMachineState } from '../net/protocol';
import { MAX_MACHINE_CHANNELS, buildInputFrame } from '../net/protocol';
import type { SemanticInputState } from '../input/types';

export const FIXED_DT = 1 / 60;
export const MAX_CATCHUP_STEPS = 4;
export const MACHINE_INPUT_REDUNDANCY = 4;

/**
 * One player-facing binding for a single named action channel. Mirrors
 * the Rust `snap_machine_controls::MachineBinding` shape.
 */
export type MachineBinding = {
  action: string;
  posKey: string;
  negKey: string | null;
  scale: number;
};

function parseBindings(raw: string): MachineBinding[] {
  if (!raw) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const parts = row.split('\t');
      return {
        action: parts[0] ?? '',
        posKey: parts[1] ?? 'KeyE',
        negKey: parts[2] && parts[2].length > 0 ? parts[2] : null,
        scale: Number(parts[3] ?? '1') || 1,
      };
    });
}

/**
 * Operator-side client prediction for one snap-machine.
 *
 * Mirrors `VehiclePredictionManager` but addresses an arbitrary set of
 * named actuator channels rather than the fixed steering/throttle/brake
 * triple. Wire order for those channels is delegated to the wasm module
 * (`getSnapMachineActionChannels`), which returns them in the same
 * deterministic order as the Rust `snap_machine::derive_action_channels`.
 */
export class MachinePredictionManager {
  private machineId: number | null = null;
  private accumulator = 0;
  private nextSeq = 1;
  private actionChannels: string[] = [];
  private bindings: MachineBinding[] = [];
  private displayName: string | null = null;

  /// Per-body world poses (px, py, pz, qx, qy, qz, qw) in body-id order.
  private bodyPoses: Float32Array = new Float32Array(0);
  private bodyCount = 0;

  constructor(
    private readonly sim: WasmSimWorldInstance,
    private readonly isLocalPreview = false,
  ) {}

  isActive(): boolean {
    return this.machineId !== null;
  }

  getMachineId(): number | null {
    return this.machineId;
  }

  getNextSeq(): number {
    return this.nextSeq;
  }

  setNextSeq(seq: number): void {
    this.nextSeq = seq;
  }

  /// Action channel names in wire-order (channel 0..N-1). The keybinding
  /// layer maps player keys to these slots.
  getActionChannels(): string[] {
    return this.actionChannels;
  }

  /// Player-facing keyboard bindings for this machine's actions.
  /// Populated from wasm `getSnapMachineBindings` on `enterMachine`.
  getBindings(): MachineBinding[] {
    return this.bindings;
  }

  /// Display name from `envelope.metadata.presetName` (e.g. "4-Wheel
  /// Car", "Crane"). `null` if the envelope had no metadata.
  getDisplayName(): string | null {
    return this.displayName;
  }

  getBodyCount(): number {
    return this.bodyCount;
  }

  /// Returns the latest body world poses for the renderer. Layout:
  /// `[px, py, pz, qx, qy, qz, qw]` per body, in body-id order.
  getBodyPoses(): Float32Array {
    return this.bodyPoses;
  }

  /// Begin operating `machineId`. The caller must have already called
  /// `sim.spawnSnapMachine` for this id (typically when first seen in a
  /// snapshot). The first server snapshot will reconcile body poses.
  enterMachine(machineId: number): void {
    this.machineId = machineId;
    this.accumulator = 0;
    this.sim.setLocalSnapMachine(machineId);

    const channelsRaw = this.sim.getSnapMachineActionChannels(machineId);
    this.actionChannels = channelsRaw ? channelsRaw.split('\n').filter(Boolean) : [];
    this.bindings = parseBindings(this.sim.getSnapMachineBindings(machineId));
    const name = this.sim.getSnapMachineDisplayName(machineId);
    this.displayName = name && name.length > 0 ? name : null;
    this.bodyCount = this.sim.getSnapMachineBodyCount(machineId);
    this.refreshBodyPoses();
  }

  exitMachine(): void {
    if (this.machineId !== null) {
      this.sim.clearLocalSnapMachine();
    }
    this.machineId = null;
    this.accumulator = 0;
    this.actionChannels = [];
    this.bindings = [];
    this.displayName = null;
    this.bodyCount = 0;
    this.bodyPoses = new Float32Array(0);
  }

  /// Run prediction ticks for one render frame and emit one InputCmd per
  /// fixed step. The last `MACHINE_INPUT_REDUNDANCY` commands are returned
  /// for packet-loss resilience (server dedups by seq).
  update(frameDeltaSec: number, input: SemanticInputState): InputCmd[] {
    if (this.machineId === null) return [];
    this.accumulator += frameDeltaSec;
    const pendingInputs: InputCmd[] = [];
    let steps = 0;

    while (this.accumulator >= FIXED_DT && steps < MAX_CATCHUP_STEPS) {
      const seq = this.nextSeq++ & 0xffff;
      const channels = input.machineChannels
        ? new Int8Array(input.machineChannels)
        : new Int8Array(MAX_MACHINE_CHANNELS);

      const frame = buildInputFrame(seq, 0, input.yaw, input.pitch);
      frame.machineChannels = channels;
      pendingInputs.push(frame);

      if (!this.isLocalPreview) {
        this.sim.tickSnapMachine(seq, channels, input.yaw, input.pitch, FIXED_DT);
      }

      this.accumulator -= FIXED_DT;
      steps++;
    }

    if (this.accumulator > FIXED_DT) {
      this.accumulator = FIXED_DT;
    }

    this.refreshBodyPoses();

    if (pendingInputs.length === 0) return [];
    return pendingInputs.slice(-MACHINE_INPUT_REDUNDANCY);
  }

  /// Reconcile against an authoritative server machine snapshot.
  reconcile(state: NetSnapMachineState, ackInputSeq: number): void {
    if (this.machineId === null || state.id !== this.machineId) return;

    // Pack into the flat layout the wasm side expects.
    const flat = new Float32Array(state.bodies.length * 14);
    for (let i = 0; i < state.bodies.length; i++) {
      const b = state.bodies[i];
      const o = i * 14;
      flat[o + 0] = b.index;
      flat[o + 1] = b.pxMm / 1000;
      flat[o + 2] = b.pyMm / 1000;
      flat[o + 3] = b.pzMm / 1000;
      flat[o + 4] = b.qxSnorm / 32767;
      flat[o + 5] = b.qySnorm / 32767;
      flat[o + 6] = b.qzSnorm / 32767;
      flat[o + 7] = b.qwSnorm / 32767;
      flat[o + 8] = b.vxCms / 100;
      flat[o + 9] = b.vyCms / 100;
      flat[o + 10] = b.vzCms / 100;
      flat[o + 11] = b.wxMrads / 1000;
      flat[o + 12] = b.wyMrads / 1000;
      flat[o + 13] = b.wzMrads / 1000;
    }

    this.sim.reconcileSnapMachine(ackInputSeq, flat, FIXED_DT);
    this.refreshBodyPoses();
  }

  /// Apply a remote machine snapshot (the operating player is *not* us).
  syncRemoteMachine(state: NetSnapMachineState): void {
    const flat = new Float32Array(state.bodies.length * 14);
    for (let i = 0; i < state.bodies.length; i++) {
      const b = state.bodies[i];
      const o = i * 14;
      flat[o + 0] = b.index;
      flat[o + 1] = b.pxMm / 1000;
      flat[o + 2] = b.pyMm / 1000;
      flat[o + 3] = b.pzMm / 1000;
      flat[o + 4] = b.qxSnorm / 32767;
      flat[o + 5] = b.qySnorm / 32767;
      flat[o + 6] = b.qzSnorm / 32767;
      flat[o + 7] = b.qwSnorm / 32767;
      flat[o + 8] = b.vxCms / 100;
      flat[o + 9] = b.vyCms / 100;
      flat[o + 10] = b.vzCms / 100;
      flat[o + 11] = b.wxMrads / 1000;
      flat[o + 12] = b.wyMrads / 1000;
      flat[o + 13] = b.wzMrads / 1000;
    }
    this.sim.syncRemoteSnapMachine(state.id, flat);
  }

  private refreshBodyPoses(): void {
    if (this.machineId === null) return;
    const poses = this.sim.getSnapMachineBodyPoses(this.machineId);
    this.bodyPoses = poses;
  }
}
