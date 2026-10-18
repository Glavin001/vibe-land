// Opens the frame's CPU clock before any other per-frame work runs.
//
// R3F sorts useFrame subscribers ascending by priority and only disables its
// automatic render for a *positive* priority, so a large negative priority
// buys "runs first" without taking over rendering. Pairing this with the
// gl.render patch (which closes the span) is what makes `cpu frame` a real
// main-thread measurement rather than a rAF-to-rAF delta that also counts
// vsync wait.

import { useFrame } from '@react-three/fiber';

import { markFrameStart, patchRendererTiming } from '../city/renderStats';

export function FrameClock(): null {
  useFrame((state) => {
    patchRendererTiming(state.gl as never);
    markFrameStart();
  }, -1000);
  return null;
}
