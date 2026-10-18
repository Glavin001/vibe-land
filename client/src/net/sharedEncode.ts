/**
 * Client packets encoded by the shared Rust encoders (shared/src/net_client.rs encode_*_js), the
 * ones the Unreal client sends, through the shared WASM package. They reproduce protocol.ts's
 * quantisation bit for bit (sharedEncode.test.ts), so the server gets the same bytes from both
 * clients. Behind the same flag as the shared decoders (`?sharedDecode=1`).
 */
import {
  encode_city_camera_drop_js,
  encode_client_hello_js,
  encode_fire_js,
  encode_input_bundle_js,
  encode_melee_js,
  encode_ping_js,
  encode_vehicle_enter_js,
  encode_vehicle_exit_js,
} from '../wasm/pkg/vibe_land_shared.js';
import {
  PROTOCOL_VERSION,
  type CityCameraDropCmd,
  type ClientHello,
  type FireCmd,
  type InputFrame,
  type MeleeCmd,
  type SharedEncoders,
} from './protocol';
import { CLIENT_MOVEMENT_CAP_FULL_PREDICTION, CLIENT_MOVEMENT_CAP_THIN_AUTHORITATIVE } from './sharedConstants';

export const sharedEncoders: SharedEncoders = {
  clientHello: (packet: ClientHello) =>
    encode_client_hello_js(
      packet.matchId,
      packet.protocolVersion ?? PROTOCOL_VERSION,
      packet.movementCapabilities ?? (CLIENT_MOVEMENT_CAP_FULL_PREDICTION | CLIENT_MOVEMENT_CAP_THIN_AUTHORITATIVE),
    ),
  inputBundle: (frames: InputFrame[]) => {
    const flat = new Float64Array(frames.length * 6);
    frames.forEach((f, i) => flat.set([f.seq, f.buttons, f.moveX, f.moveY, f.yaw, f.pitch], i * 6));
    return encode_input_bundle_js(flat);
  },
  fire: (p: FireCmd) =>
    encode_fire_js(p.seq, p.shotId, p.weapon, p.clientFireTimeUs, p.clientInterpMs, p.clientDynamicInterpMs, p.dir[0], p.dir[1], p.dir[2]),
  melee: (p: MeleeCmd) => encode_melee_js(p.seq, p.swingId, p.clientTimeUs, p.yaw, p.pitch),
  cityCameraDrop: (c: CityCameraDropCmd) => encode_city_camera_drop_js(c.position[0], c.position[1], c.position[2], c.yaw, c.pitch),
  vehicleEnter: (vehicleId: number, seat: number) => encode_vehicle_enter_js(vehicleId, seat),
  vehicleExit: (vehicleId: number) => encode_vehicle_exit_js(vehicleId),
  ping: (nonce: number) => encode_ping_js(nonce),
};
