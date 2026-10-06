// Town-kit foliage on the WebGPU path: the same lit, textured, cut-out leaf
// card, with its cut-out done in nodes rather than through `alphaTest`.
//
// Why: WebGPURenderer draws every shadow caster with ONE shared shadow
// material and copies each caster's `alphaTest` onto it before the draw.
// Crossing zero bumps that material's version, and a version change makes
// every render object recompute its full material cache key (a string over
// every material property) on its next draw. Leaves at 0.35 between
// buildings at 0 bumped it back and forth all through every shadow pass, so
// every caster paid that key every frame: 27-43 ms of main-thread CPU per
// frame in Vibe Town's 1,037 tree attachments (2026-10-06). Keeping
// `alphaTest` at 0 like every other caster leaves the shared material alone;
// the leaf discards itself, in its own pass and in the shadow pass.
//
// Only imported behind __WEBGPU__; registered by @render-backend/install.

import type * as THREE from 'three';
import { Discard, Fn, If, float, texture, uv, vec4 } from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';

import type { OutdoorLeafOptions } from './outdoorAttachments';

// TSL nodes are loosely typed in @types/three 0.170.
/* eslint-disable @typescript-eslint/no-explicit-any */

export function outdoorLeafNodeMaterial({ color, map, side, alphaTest, roughness }: OutdoorLeafOptions): THREE.MeshStandardMaterial {
  const material = new MeshStandardNodeMaterial({ color, map, side, roughness }) as any;
  // Its own pass: discard below the cut, as alphaTest would.
  material.alphaTestNode = float(alphaTest);
  // The shadow pass: the shared shadow material takes this node's colour, and
  // the discard comes with it.
  material.castShadowNode = (Fn as any)(() => {
    If((texture as any)(map, uv()).a.lessThan(alphaTest), () => { Discard(); });
    return vec4(0, 0, 0, 1);
  })();
  return material as THREE.MeshStandardMaterial;
}
