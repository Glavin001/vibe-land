// A TSL uniform that follows a `{ value }` holder, the shape every GLSL
// material here shares its uniforms in, so one holder drives both renderers.
// Numbers are re-read every frame; vectors and colours are the holder's own
// object, mutated in place by whoever owns it.
//
// (three's reference() looked right but froze at its first value when
// built inside a Fn: the grass clock never moved.)
//
// Only imported behind __WEBGPU__.

import { uniform } from 'three/tsl';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export function liveUniform(holder: { value: unknown }, type?: string): Node {
  if (typeof holder.value === 'number') {
    return (uniform(holder.value, type) as Node).onRenderUpdate(() => holder.value as number);
  }
  return uniform(holder.value as never, type);
}
