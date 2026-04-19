export type DestructibleTuning = {
  wallMaterialScale: number;
  towerMaterialScale: number;
};

export const DEFAULT_DESTRUCTIBLE_TUNING: DestructibleTuning = Object.freeze({
  wallMaterialScale: 10,
  towerMaterialScale: 10,
});

export const DESTRUCTIBLE_MATERIAL_SCALE_MIN = 1;
export const DESTRUCTIBLE_MATERIAL_SCALE_MAX = 100;
export const DESTRUCTIBLE_MATERIAL_SCALE_STEP = 1;

export function clampDestructibleMaterialScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DESTRUCTIBLE_TUNING.wallMaterialScale;
  const rounded = Math.round(value / DESTRUCTIBLE_MATERIAL_SCALE_STEP) * DESTRUCTIBLE_MATERIAL_SCALE_STEP;
  return Math.max(
    DESTRUCTIBLE_MATERIAL_SCALE_MIN,
    Math.min(DESTRUCTIBLE_MATERIAL_SCALE_MAX, Number(rounded.toFixed(2))),
  );
}
