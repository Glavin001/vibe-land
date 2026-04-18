import { SIM_HZ } from '../net/protocol';

export const FIXED_DT = 1 / SIM_HZ;
// Raised from 4 → 8 so that slow-rendering CI environments (swiftshader at
// ~5 fps) can still run physics at ~67% real-time instead of ~33%, giving
// vehicles enough simulation time to reach destructible walls in E2E tests.
// Safe at full frame-rate: the accumulator never exceeds one step so the cap
// is never hit in normal 60 fps play.
export const CLIENT_MAX_CATCHUP_STEPS = 8;

// These are client-side buffering/tolerance knobs rather than authoritative
// gameplay rules, so they stay in TS but are centralized here.
export const CLIENT_PREDICTION_MAX_PENDING_INPUTS = 30;
export const VEHICLE_CLIENT_MAX_PENDING_INPUTS = 30;
export const VEHICLE_CLIENT_CATCHUP_THRESHOLD = 8;
export const VEHICLE_INPUT_REDUNDANCY = 4;
export const VEHICLE_CLIENT_CATCHUP_KEEP = VEHICLE_INPUT_REDUNDANCY;
