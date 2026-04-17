// Derived from Kinema's renderer/pipelineProfile.ts (MIT).
// See CREDITS.md at the repo root.
//
// Framework-agnostic quality-tier descriptor. Pipeline builders (R3F or
// vanilla Three.js) can consume the descriptor to wire pixel ratio,
// shadow map sizes, bloom/SSR/CAS, and LUT passes.

export type GraphicsProfile = 'performance' | 'balanced' | 'cinematic';
export type AntiAliasingMode = 'none' | 'fxaa' | 'smaa' | 'taa';
export type PipelineKind = 'direct' | 'minimal' | 'balanced' | 'cinematic';
export type MrtAttachment = 'emissive' | 'metalrough';

export interface RendererPipelineDescriptor {
  kind: PipelineKind;
  useRenderPipeline: boolean;
  manualRenderOutput: boolean;
  outputColorTransform: boolean;
  aaMode: AntiAliasingMode;
  maxPixelRatio: number;
  shadowMapSize: number;
  usePrePassNormals: boolean;
  useAo: boolean;
  useAoDenoise: boolean;
  aoResolutionScale: number;
  aoSamples: number;
  useBloom: boolean;
  useSSR: boolean;
  useCAS: boolean;
  mrtAttachments: MrtAttachment[];
}

export interface RendererPipelineOptions {
  profile: GraphicsProfile;
  aaMode: AntiAliasingMode;
  postProcessingEnabled: boolean;
  aoEnabled: boolean;
  aoOnlyView: boolean;
  bloomEnabled: boolean;
  ssrEnabled: boolean;
  casEnabled: boolean;
  casStrength: number;
  vignetteEnabled: boolean;
  lutEnabled: boolean;
}

export function getRendererMaxPixelRatio(profile: GraphicsProfile): number {
  if (profile === 'performance') return 1.0;
  if (profile === 'balanced') return 1.5;
  return 2.0;
}

export function getShadowMapSizeForProfile(profile: GraphicsProfile): number {
  return profile === 'cinematic' ? 2048 : 1024;
}

export function buildRendererPipelineDescriptor(
  options: RendererPipelineOptions,
): RendererPipelineDescriptor {
  const {
    profile,
    aaMode,
    postProcessingEnabled,
    aoEnabled,
    aoOnlyView,
    bloomEnabled,
    ssrEnabled,
    casEnabled,
    casStrength,
    vignetteEnabled,
    lutEnabled,
  } = options;

  const useAo =
    aoOnlyView ||
    (postProcessingEnabled && aoEnabled && profile !== 'performance');
  const useSSR =
    postProcessingEnabled && ssrEnabled && profile === 'cinematic';
  const useBloom =
    postProcessingEnabled && bloomEnabled && profile !== 'performance';
  const useCAS =
    postProcessingEnabled &&
    profile === 'cinematic' &&
    casEnabled &&
    casStrength > 0 &&
    aaMode !== 'none';
  const usePrePassNormals = useSSR || (useAo && profile === 'cinematic');
  const useAoDenoise = useAo && profile === 'cinematic';

  const mrtAttachments: MrtAttachment[] = [];
  if (useSSR) mrtAttachments.push('metalrough');
  if (useBloom) mrtAttachments.push('emissive');

  const needsDisplayPost =
    postProcessingEnabled &&
    (aaMode !== 'none' ||
      vignetteEnabled ||
      lutEnabled ||
      useBloom ||
      useSSR ||
      useCAS);
  const useRenderPipeline = useAo || needsDisplayPost;
  const manualRenderOutput = useRenderPipeline;

  let kind: PipelineKind = 'direct';
  if (useRenderPipeline) {
    if (profile === 'cinematic') kind = 'cinematic';
    else if (profile === 'balanced') kind = 'balanced';
    else kind = 'minimal';
  }

  return {
    kind,
    useRenderPipeline,
    manualRenderOutput,
    outputColorTransform: !manualRenderOutput,
    aaMode,
    maxPixelRatio: getRendererMaxPixelRatio(profile),
    shadowMapSize: getShadowMapSizeForProfile(profile),
    usePrePassNormals,
    useAo,
    useAoDenoise,
    aoResolutionScale: profile === 'cinematic' ? 1.0 : 0.5,
    aoSamples: profile === 'cinematic' ? 16 : 8,
    useBloom,
    useSSR,
    useCAS,
    mrtAttachments,
  };
}
