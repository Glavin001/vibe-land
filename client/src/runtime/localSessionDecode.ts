import {
  energyFromCenti,
  netDynamicBodyStateToMeters,
  netVehicleStateToMeters,
  type BatteryStateMeters,
  type DynamicBodyStateMeters,
  type NetBatteryState,
  type NetDynamicBodyState,
  type NetPlayerState,
  type NetVehicleState,
  type VehicleStateMeters,
} from '../net/protocol';

export const SNAPSHOT_META_STRIDE = 4;
export const PLAYER_STATE_STRIDE = 12;
export const DYNAMIC_BODY_STATE_STRIDE = 18;
export const VEHICLE_STATE_STRIDE = 21;
export const BATTERY_STATE_STRIDE = 7;

export type LocalSessionSnapshotMeta = {
  serverTimeUs: number;
  serverTick: number;
  ackInputSeq: number;
  playerId: number;
};

export function decodeLocalSessionSnapshotMeta(raw: ArrayLike<number>): LocalSessionSnapshotMeta | null {
  if (raw.length < SNAPSHOT_META_STRIDE) return null;
  return {
    serverTimeUs: Math.trunc(raw[0] ?? 0),
    serverTick: Math.trunc(raw[1] ?? 0),
    ackInputSeq: Math.trunc(raw[2] ?? 0),
    playerId: Math.trunc(raw[3] ?? 0),
  };
}

export function decodeLocalSessionPlayerState(raw: ArrayLike<number>): NetPlayerState | null {
  if (raw.length < PLAYER_STATE_STRIDE) return null;
  return {
    id: Math.trunc(raw[0] ?? 0),
    pxMm: Math.trunc(raw[1] ?? 0),
    pyMm: Math.trunc(raw[2] ?? 0),
    pzMm: Math.trunc(raw[3] ?? 0),
    vxCms: Math.trunc(raw[4] ?? 0),
    vyCms: Math.trunc(raw[5] ?? 0),
    vzCms: Math.trunc(raw[6] ?? 0),
    yawI16: Math.trunc(raw[7] ?? 0),
    pitchI16: Math.trunc(raw[8] ?? 0),
    hp: Math.trunc(raw[9] ?? 0),
    flags: Math.trunc(raw[10] ?? 0),
    energyCenti: Math.trunc(raw[11] ?? 0),
  };
}

export function decodeLocalSessionBatteryState(raw: ArrayLike<number>, offset: number): NetBatteryState {
  return {
    id: Math.trunc(raw[offset] ?? 0),
    pxMm: Math.trunc(raw[offset + 1] ?? 0),
    pyMm: Math.trunc(raw[offset + 2] ?? 0),
    pzMm: Math.trunc(raw[offset + 3] ?? 0),
    energyCenti: Math.trunc(raw[offset + 4] ?? 0),
    radiusCm: Math.trunc(raw[offset + 5] ?? 0),
    heightCm: Math.trunc(raw[offset + 6] ?? 0),
  };
}

export function decodeLocalSessionPlayers(raw: ArrayLike<number>): NetPlayerState[] {
  const players: NetPlayerState[] = [];
  for (let offset = 0; offset + PLAYER_STATE_STRIDE <= raw.length; offset += PLAYER_STATE_STRIDE) {
    players.push({
      id: Math.trunc(raw[offset] ?? 0),
      pxMm: Math.trunc(raw[offset + 1] ?? 0),
      pyMm: Math.trunc(raw[offset + 2] ?? 0),
      pzMm: Math.trunc(raw[offset + 3] ?? 0),
      vxCms: Math.trunc(raw[offset + 4] ?? 0),
      vyCms: Math.trunc(raw[offset + 5] ?? 0),
      vzCms: Math.trunc(raw[offset + 6] ?? 0),
      yawI16: Math.trunc(raw[offset + 7] ?? 0),
      pitchI16: Math.trunc(raw[offset + 8] ?? 0),
      hp: Math.trunc(raw[offset + 9] ?? 0),
      flags: Math.trunc(raw[offset + 10] ?? 0),
      energyCenti: Math.trunc(raw[offset + 11] ?? 0),
    });
  }
  return players;
}

export function decodeLocalSessionDynamicBodyState(raw: ArrayLike<number>, offset: number): NetDynamicBodyState {
  return {
    id: Math.trunc(raw[offset] ?? 0),
    shapeType: Math.trunc(raw[offset + 1] ?? 0),
    pxMm: Math.trunc(raw[offset + 2] ?? 0),
    pyMm: Math.trunc(raw[offset + 3] ?? 0),
    pzMm: Math.trunc(raw[offset + 4] ?? 0),
    qxSnorm: Math.trunc(raw[offset + 5] ?? 0),
    qySnorm: Math.trunc(raw[offset + 6] ?? 0),
    qzSnorm: Math.trunc(raw[offset + 7] ?? 0),
    qwSnorm: Math.trunc(raw[offset + 8] ?? 0),
    hxCm: Math.trunc(raw[offset + 9] ?? 0),
    hyCm: Math.trunc(raw[offset + 10] ?? 0),
    hzCm: Math.trunc(raw[offset + 11] ?? 0),
    vxCms: Math.trunc(raw[offset + 12] ?? 0),
    vyCms: Math.trunc(raw[offset + 13] ?? 0),
    vzCms: Math.trunc(raw[offset + 14] ?? 0),
    wxMrads: Math.trunc(raw[offset + 15] ?? 0),
    wyMrads: Math.trunc(raw[offset + 16] ?? 0),
    wzMrads: Math.trunc(raw[offset + 17] ?? 0),
  };
}

export function decodeLocalSessionVehicleState(raw: ArrayLike<number>, offset: number): NetVehicleState {
  return {
    id: Math.trunc(raw[offset] ?? 0),
    vehicleType: Math.trunc(raw[offset + 1] ?? 0),
    flags: Math.trunc(raw[offset + 2] ?? 0),
    driverId: Math.trunc(raw[offset + 3] ?? 0),
    pxMm: Math.trunc(raw[offset + 4] ?? 0),
    pyMm: Math.trunc(raw[offset + 5] ?? 0),
    pzMm: Math.trunc(raw[offset + 6] ?? 0),
    qxSnorm: Math.trunc(raw[offset + 7] ?? 0),
    qySnorm: Math.trunc(raw[offset + 8] ?? 0),
    qzSnorm: Math.trunc(raw[offset + 9] ?? 0),
    qwSnorm: Math.trunc(raw[offset + 10] ?? 0),
    vxCms: Math.trunc(raw[offset + 11] ?? 0),
    vyCms: Math.trunc(raw[offset + 12] ?? 0),
    vzCms: Math.trunc(raw[offset + 13] ?? 0),
    wxMrads: Math.trunc(raw[offset + 14] ?? 0),
    wyMrads: Math.trunc(raw[offset + 15] ?? 0),
    wzMrads: Math.trunc(raw[offset + 16] ?? 0),
    wheelData: [
      Math.trunc(raw[offset + 17] ?? 0),
      Math.trunc(raw[offset + 18] ?? 0),
      Math.trunc(raw[offset + 19] ?? 0),
      Math.trunc(raw[offset + 20] ?? 0),
    ],
  };
}

export function decodeLocalSessionDynamicBodies(raw: ArrayLike<number>): DynamicBodyStateMeters[] {
  const bodies: DynamicBodyStateMeters[] = [];
  for (let offset = 0; offset + DYNAMIC_BODY_STATE_STRIDE <= raw.length; offset += DYNAMIC_BODY_STATE_STRIDE) {
    bodies.push(netDynamicBodyStateToMeters(decodeLocalSessionDynamicBodyState(raw, offset)));
  }
  return bodies;
}

export function decodeLocalSessionVehicles(raw: ArrayLike<number>): VehicleStateMeters[] {
  const vehicles: VehicleStateMeters[] = [];
  for (let offset = 0; offset + VEHICLE_STATE_STRIDE <= raw.length; offset += VEHICLE_STATE_STRIDE) {
    vehicles.push(netVehicleStateToMeters(decodeLocalSessionVehicleState(raw, offset)));
  }
  return vehicles;
}

export function decodeLocalSessionBatteries(raw: ArrayLike<number>): BatteryStateMeters[] {
  const batteries: BatteryStateMeters[] = [];
  for (let offset = 0; offset + BATTERY_STATE_STRIDE <= raw.length; offset += BATTERY_STATE_STRIDE) {
    const battery = decodeLocalSessionBatteryState(raw, offset);
    batteries.push({
      id: battery.id,
      position: [battery.pxMm / 1000, battery.pyMm / 1000, battery.pzMm / 1000],
      energy: energyFromCenti(battery.energyCenti),
      radius: battery.radiusCm / 100,
      height: battery.heightCm / 100,
    });
  }
  return batteries;
}
