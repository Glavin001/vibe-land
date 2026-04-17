// Renderer pipeline helpers derived from Kinema (MIT).
// See CREDITS.md at the repo root.

export {
  buildRendererPipelineDescriptor,
  getRendererMaxPixelRatio,
  getShadowMapSizeForProfile,
  type AntiAliasingMode,
  type GraphicsProfile,
  type MrtAttachment,
  type PipelineKind,
  type RendererPipelineDescriptor,
  type RendererPipelineOptions,
} from './qualityProfile';

export {
  sanitizeSceneForCompatibility,
  type CompatibilityMaterialSanitizationResult,
} from './compatibilityMaterialSanitizer';

export {
  ENVIRONMENT_PRESETS,
  ENVIRONMENT_PRESET_LIST,
  type EnvironmentPreset,
  type EnvironmentPresetId,
} from './environmentPresets';

export {
  LUT_PRESETS,
  getLutPreset,
  type LutFormat,
  type LutPreset,
} from './lutPresets';
