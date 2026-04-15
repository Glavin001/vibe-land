import { describe, expect, it } from 'vitest';
import type { SemanticInputState } from '../input/types';
import type { NetVehicleState } from '../net/protocol';
import type { WasmSimWorldInstance } from '../wasm/sharedPhysics';
import {
  FIXED_DT,
  VEHICLE_MAX_PENDING_INPUTS,
  VEHICLE_CLIENT_CATCHUP_KEEP,
  VehiclePredictionManager,
} from './vehiclePredictionManager';

function seqIsNewer(a: number, b: number): boolean {
  return ((a - b) & 0xffff) < 0x8000 && a !== b;
}

class FakeVehicleSim {
  pendingSeqs: number[] = [];
  tickedSeqs: number[] = [];
  syncRemoteVehicleCalls = 0;
  setLocalVehicleCalls = 0;
  clearLocalVehicleCalls = 0;
  stepDynamicsCalls = 0;
  reconcileVehicleCalls = 0;
  pruneVehiclePendingInputsThroughCalls = 0;
  nextReconcileResult: number[] | null = null;

  syncRemoteVehicle(): void {
    this.syncRemoteVehicleCalls += 1;
  }

  setLocalVehicle(): void {
    this.setLocalVehicleCalls += 1;
    this.pendingSeqs = [];
  }

  clearLocalVehicle(): void {
    this.clearLocalVehicleCalls += 1;
    this.pendingSeqs = [];
  }

  stepDynamics(): void {
    this.stepDynamicsCalls += 1;
  }

  tickVehicle(seq: number): number[] {
    this.pendingSeqs.push(seq);
    this.tickedSeqs.push(seq);
    return [seq * 0.1, 0, 0, 0, 0, 0, 1, 0, 0, 0];
  }

  reconcileVehicle(
    _posThreshold: number,
    _rotThreshold: number,
    _velThreshold: number,
    _angvelThreshold: number,
    ackSeq: number,
  ): number[] {
    this.reconcileVehicleCalls += 1;
    this.pendingSeqs = this.pendingSeqs.filter((seq) => seqIsNewer(seq, ackSeq));
    const result = this.nextReconcileResult ?? [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    this.nextReconcileResult = null;
    return result;
  }

  getVehiclePendingCount(): number {
    return this.pendingSeqs.length;
  }

  pruneVehiclePendingInputsThrough(ackSeq: number): void {
    this.pruneVehiclePendingInputsThroughCalls += 1;
    this.pendingSeqs = this.pendingSeqs.filter((seq) => seqIsNewer(seq, ackSeq));
  }
}

function createManager(isLocalPreview = false) {
  const sim = new FakeVehicleSim();
  const manager = new VehiclePredictionManager(sim as unknown as WasmSimWorldInstance, isLocalPreview);
  const initState: NetVehicleState = {
    id: 1,
    vehicleType: 0,
    flags: 0,
    driverId: 1,
    pxMm: 0,
    pyMm: 0,
    pzMm: 0,
    qxSnorm: 0,
    qySnorm: 0,
    qzSnorm: 0,
    qwSnorm: 32767,
    vxCms: 0,
    vyCms: 0,
    vzCms: 0,
    wxMrads: 0,
    wyMrads: 0,
    wzMrads: 0,
    wheelData: [0, 0, 0, 0],
  };
  manager.enterVehicle(1, initState);
  const input: SemanticInputState = {
    moveX: 0,
    moveY: 1,
    yaw: 0,
    pitch: 0,
    buttons: 0,
  };
  return { sim, manager, input, initState };
}

describe('VehiclePredictionManager', () => {
  it('re-sends recent unacked vehicle inputs across render frames', () => {
    const { manager, input, initState } = createManager();

    const first = manager.update(FIXED_DT, input);
    expect(first.map((frame) => frame.seq)).toEqual([1]);

    const resend = manager.update(FIXED_DT * 0.5, input);
    expect(resend.map((frame) => frame.seq)).toEqual([1]);

    manager.reconcile(initState, 1);
    const idleAfterAck = manager.update(0, input);
    expect(idleAfterAck).toHaveLength(0);

    const nextTick = manager.update(FIXED_DT, input);
    expect(nextTick.map((frame) => frame.seq)).toEqual([2]);
  });

  it('keeps generating fresh vehicle ticks while collapsing stale replay backlog', () => {
    const { sim, manager, input } = createManager();

    for (let seq = 1; seq <= VEHICLE_MAX_PENDING_INPUTS; seq += 1) {
      const sent = manager.update(FIXED_DT, input);
      expect(sent.at(-1)?.seq).toBe(seq);
    }
    expect(sim.getVehiclePendingCount()).toBeGreaterThanOrEqual(VEHICLE_CLIENT_CATCHUP_KEEP);
    expect(sim.getVehiclePendingCount()).toBeLessThanOrEqual(8);
    expect(sim.pruneVehiclePendingInputsThroughCalls).toBeGreaterThan(0);
    expect(sim.tickedSeqs).toHaveLength(VEHICLE_MAX_PENDING_INPUTS);

    const continued = manager.update(FIXED_DT, input);
    expect(sim.tickedSeqs).toHaveLength(VEHICLE_MAX_PENDING_INPUTS + 1);
    expect(continued.map((frame) => frame.seq)).toEqual([28, 29, 30, 31]);
  });

  it('local preview enter and exit do not activate a second local vehicle sim', () => {
    const { sim, manager } = createManager(true);

    expect(sim.syncRemoteVehicleCalls).toBe(0);
    expect(sim.setLocalVehicleCalls).toBe(0);
    expect(sim.stepDynamicsCalls).toBe(0);

    manager.exitVehicle();

    expect(sim.clearLocalVehicleCalls).toBe(0);
  });

  it('multiplayer enter does not advance vehicle time during contact warm-up', () => {
    const { sim } = createManager();

    expect(sim.syncRemoteVehicleCalls).toBe(1);
    expect(sim.setLocalVehicleCalls).toBe(1);
    expect(sim.stepDynamicsCalls).toBe(0);
  });

  it('local preview keeps generating fixed-step inputs without ticking local vehicle physics', () => {
    const { sim, manager, input } = createManager(true);

    expect(manager.update(FIXED_DT * 2, input).map((frame) => frame.seq)).toEqual([1, 2]);
    expect(sim.tickedSeqs).toHaveLength(0);
    expect(sim.getVehiclePendingCount()).toBe(0);
  });

  it('local preview reconcile prunes acked inputs without syncing vehicle pose into the sim', () => {
    const { sim, manager, input, initState } = createManager(true);

    expect(manager.update(FIXED_DT * 2, input).map((frame) => frame.seq)).toEqual([1, 2]);

    manager.reconcile({
      ...initState,
      pzMm: 2500,
      vxCms: 250,
    }, 1);

    expect(sim.syncRemoteVehicleCalls).toBe(0);
    expect(sim.reconcileVehicleCalls).toBe(0);
    expect(manager.update(0, input).map((frame) => frame.seq)).toEqual([2]);
  });

  it('local preview keeps issuing fresh inputs when backlog exceeds the old cap', () => {
    const { manager, input } = createManager(true);

    for (let seq = 1; seq <= VEHICLE_MAX_PENDING_INPUTS; seq += 1) {
      expect(manager.update(FIXED_DT, input).at(-1)?.seq).toBe(seq);
    }

    const continued = manager.update(FIXED_DT, input);
    expect(continued.map((frame) => frame.seq)).toEqual([28, 29, 30, 31]);
  });

  it('keeps vehicle resend bursts fixed-width even when unacked backlog becomes unhealthy', () => {
    const { sim, manager, input } = createManager();

    for (let seq = 1; seq <= 40; seq += 1) {
      manager.update(FIXED_DT, input);
    }

    const resent = manager.update(0, input);
    expect(resent).toHaveLength(4);
    expect(resent[0].seq).toBe(37);
    expect(resent.at(-1)?.seq).toBe(40);
    expect(sim.getVehiclePendingCount()).toBeLessThanOrEqual(8);
  });

  it('snaps tiny local vehicle corrections instead of smoothing them into vibration', () => {
    const { sim, manager, initState } = createManager();

    sim.nextReconcileResult = [0.02, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0.02, 0, 0, 1];
    manager.reconcile({ ...initState, pxMm: 20 }, 0);

    expect(manager.getCorrectionMagnitude()).toBe(0);
  });

  it('snaps large vertical corrections immediately to avoid visible terrain clipping', () => {
    const { sim, manager, initState } = createManager();

    sim.nextReconcileResult = [0, 0.15, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.15, 0, 1];
    manager.reconcile({ ...initState, pyMm: 150 }, 0);

    expect(manager.getCorrectionMagnitude()).toBe(0);
  });

  it('keeps a narrow band of planar-only smoothing for medium corrections', () => {
    const { sim, manager, initState } = createManager();

    sim.nextReconcileResult = [0.12, 0.02, -0.06, 0, 0, 0, 1, 0, 0, 0, 0.12, 0.02, -0.06, 1];
    manager.reconcile({ ...initState, pxMm: 120, pyMm: 20, pzMm: -60 }, 0);

    expect(manager.getCorrectionMagnitude()).toBeCloseTo(Math.hypot(0.12, 0.06), 6);
  });
});
