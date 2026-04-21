import type { DamageOverlayState } from './useDamageFeedback';

type DamageOverlayProps = DamageOverlayState & {
  visible?: boolean;
};

const RED = '220, 30, 30';

function clampAlpha(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function DamageOverlay({
  front,
  back,
  left,
  right,
  vignette,
  death,
  visible = true,
}: DamageOverlayProps) {
  const f = clampAlpha(front);
  const b = clampAlpha(back);
  const l = clampAlpha(left);
  const r = clampAlpha(right);
  const v = clampAlpha(vignette);
  const d = clampAlpha(death);
  const anyVisible = visible && (f + b + l + r + v + d) > 0.001;
  if (!anyVisible) {
    return null;
  }

  const directionalBackground = `
    radial-gradient(ellipse at center top, rgba(${RED}, ${f.toFixed(3)}) 0%, transparent 55%),
    radial-gradient(ellipse at center bottom, rgba(${RED}, ${b.toFixed(3)}) 0%, transparent 55%),
    radial-gradient(ellipse at left center, rgba(${RED}, ${l.toFixed(3)}) 0%, transparent 55%),
    radial-gradient(ellipse at right center, rgba(${RED}, ${r.toFixed(3)}) 0%, transparent 55%)
  `.trim();

  const vignetteAlpha = Math.max(v, d * 0.85);
  const vignetteBackground =
    vignetteAlpha > 0
      ? `radial-gradient(ellipse at center, transparent 35%, rgba(${RED}, ${vignetteAlpha.toFixed(3)}) 100%)`
      : 'none';

  return (
    <div
      data-testid="damage-overlay"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 7,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: directionalBackground,
          mixBlendMode: 'screen',
          willChange: 'opacity',
        }}
      />
      {vignetteBackground !== 'none' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: vignetteBackground,
            mixBlendMode: 'multiply',
          }}
        />
      )}
    </div>
  );
}
