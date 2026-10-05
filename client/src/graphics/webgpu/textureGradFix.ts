// three r182's node builders drop the array layer when an array texture is
// sampled with explicit gradients: WGSL emits textureSampleGrad without its
// array_index (a compile error; the source carries a TODO), and the WebGL2
// fallback's generateTextureGrad takes no layer at all, so the caller's
// layer lands in its offset slot. The city's hero stack samples its texture
// arrays that way (scene/cityHeroNodes.ts): explicit gradients are what make
// its per-plane branches legal, and they keep anisotropic filtering, which a
// manual mip level would not.
//
// Neither builder class is exported, so the fix goes onto the prototype of
// whichever builder the renderer's backend creates. Remove once three emits
// the layer itself.

type Builder = {
  shaderStage?: string;
  generateTextureGrad: (...args: unknown[]) => string;
  __vibeArrayGrad?: true;
};
type Backend = { createNodeBuilder?: (object: object, renderer: unknown) => object };

export function fixArrayTextureGrad(renderer: { backend?: Backend }): void {
  const backend = renderer.backend;
  if (!backend?.createNodeBuilder) return;
  const proto = Object.getPrototypeOf(backend.createNodeBuilder({}, renderer)) as Builder;
  if (proto.__vibeArrayGrad) return;
  const original = proto.generateTextureGrad;
  const wgsl = original.length >= 6; // (texture, property, uv, grad, depth, offset[, stage])
  proto.generateTextureGrad = function (this: Builder, ...args: unknown[]) {
    const [texture, property, uv, grad, depth, offset] = args as [unknown, string, string, [string, string], string | null, string | null];
    if (!depth) return original.apply(this, wgsl ? args : [texture, property, uv, grad, offset]);
    if (wgsl) {
      return `textureSampleGrad( ${property}, ${property}_sampler, ${uv}, ${depth}, ${grad[0]}, ${grad[1]}${offset ? `, ${offset}` : ''} )`;
    }
    const at = `vec3( ${uv}, float( ${depth} ) )`;
    return offset
      ? `textureGradOffset( ${property}, ${at}, ${grad[0]}, ${grad[1]}, ${offset} )`
      : `textureGrad( ${property}, ${at}, ${grad[0]}, ${grad[1]} )`;
  };
  proto.__vibeArrayGrad = true;
}
