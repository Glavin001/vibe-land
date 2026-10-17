// Fixture for client-core/src/vehicle_predictor.rs: the web's driven-car predictor on a fixed scenario
// (a stock car at 8 m/s, 30 inputs: steer left, then right, throttle then brake, handbrake), swept
// against the flat terrain. Run: npx tsx scripts/vehicle-predictor-fixture.mts '<proxy json>'
import { VehiclePresentationPredictor, type VehicleProxy, type Sweep } from '../src/physics/vehiclePresentation';
import { Quaternion, Vector3 } from 'three';

const proxy: VehicleProxy = JSON.parse(process.argv[2]);
// The flat terrain at y = 0, as the Rust port's sweep_ground.
const sweep: Sweep = (position, quaternion, delta, half, radius = 0) => {
  const q = new Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  let lowest = Infinity;
  if (radius > 0) lowest = position[1] - radius;
  else for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const c = new Vector3(sx * half[0], sy * half[1], sz * half[2]).applyQuaternion(q);
    lowest = Math.min(lowest, position[1] + c.y);
  }
  if (delta[1] >= 0) return null;
  const fraction = lowest <= 0 ? 0 : lowest / -delta[1];
  return fraction <= 1 ? { fraction, normal: [0, 1, 0] } : null;
};
const lowestWheel = Math.min(...proxy.wheels.map(w => w[1]));
const sample = { serverTimeUs: 0, position: [0, proxy.radius - lowestWheel, 0] as [number, number, number],
  quaternion: [0, 0, 0, 1] as [number, number, number, number], linearVelocity: [0, 0, 8] as [number, number, number],
  angularVelocity: [0, 0, 0] as [number, number, number] } as any;
const p = new VehiclePresentationPredictor(sweep);
const inputs = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, buttons: i > 20 ? 16 : 0, moveX: i < 10 ? -127 : 64, moveY: i < 15 ? 127 : -90, yaw: 0, pitch: 0 }));
p.record(3, inputs as any);
p.observe(3, sample, 0, proxy, 0);
const pose = p.pose();
console.log(JSON.stringify(pose));
