// Runtime-tunable rendering flags for the Kinema feature wiring.
// Persisted to localStorage so tweaks survive reloads.

export type RenderSettings = {
  /** When true, gl.toneMapping = ACESFilmicToneMapping; else NoToneMapping. */
  aceTonemapping: boolean;
  /** gl.toneMappingExposure — only meaningful when tonemapping is on. */
  toneMappingExposure: number;
  /** When true, mounts <Environment> HDR IBL. */
  environmentEnabled: boolean;
  /** <Environment environmentIntensity> — contribution of the IBL. */
  environmentIntensity: number;
  /** When true, mounts <PostFX> (EffectComposer + LUT color grade). */
  postFxEnabled: boolean;
};

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  aceTonemapping: false,
  toneMappingExposure: 1.0,
  environmentEnabled: false,
  environmentIntensity: 0.35,
  postFxEnabled: false,
};

const STORAGE_KEY = 'vibe-land:render-settings';

export function loadRenderSettings(): RenderSettings {
  try {
    if (typeof window === 'undefined') return DEFAULT_RENDER_SETTINGS;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RENDER_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<RenderSettings>;
    return { ...DEFAULT_RENDER_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_RENDER_SETTINGS;
  }
}

export function saveRenderSettings(settings: RenderSettings): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore quota / private-mode failures
  }
}
