import { useCallback, useEffect, useRef, useState } from 'react';

export type DamageDirectionWeights = {
  front: number;
  back: number;
  left: number;
  right: number;
};

export type DamageFeedbackInput = {
  amount: number;
  weights: DamageDirectionWeights;
  durationMs?: number;
  startedAtMs?: number;
};

export type DamageFeedbackController = {
  pushEvent: (input: DamageFeedbackInput) => void;
  setDead: (dead: boolean) => void;
  reset: () => void;
};

export type DamageOverlayState = {
  front: number;
  back: number;
  left: number;
  right: number;
  vignette: number;
  death: number;
};

const DEFAULT_DURATION_MS = 1200;
const DEATH_FADE_OUT_MS = 250;
const DEATH_HOLD_PEAK = 0.6;
const VIGNETTE_GAIN = 0.7;
const PEAK_DAMAGE_REF = 35;
const PEAK_ALPHA_CAP = 0.75;
const DIRECTION_LOBE_POW = 1.5;

type ActiveEvent = {
  amount: number;
  weights: DamageDirectionWeights;
  startedAtMs: number;
  durationMs: number;
};

const ZERO_STATE: DamageOverlayState = Object.freeze({
  front: 0,
  back: 0,
  left: 0,
  right: 0,
  vignette: 0,
  death: 0,
});

const ZERO_WEIGHTS: DamageDirectionWeights = Object.freeze({
  front: 0,
  back: 0,
  left: 0,
  right: 0,
});

export function computeBodyLocalDirectionWeights(
  attackerWorldPos: [number, number, number],
  victimWorldPos: [number, number, number],
  yaw: number,
): DamageDirectionWeights {
  const dx = attackerWorldPos[0] - victimWorldPos[0];
  const dz = attackerWorldPos[2] - victimWorldPos[2];
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) {
    // Attacker on top of victim — bias to front so they still see a flash.
    return { front: 1, back: 0, left: 0, right: 0 };
  }
  const sinY = Math.sin(yaw);
  const cosY = Math.cos(yaw);
  // Forward axis (yaw=0 faces +Z); right axis is +X when facing +Z.
  const lz = dx * sinY + dz * cosY;
  const lx = dx * cosY - dz * sinY;
  const angle = Math.atan2(lx, lz); // 0 = front, +π/2 = right
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const eps = 1e-6;
  const front = Math.max(0, cosA - eps) ** DIRECTION_LOBE_POW;
  const back = Math.max(0, -cosA - eps) ** DIRECTION_LOBE_POW;
  const right = Math.max(0, sinA - eps) ** DIRECTION_LOBE_POW;
  const left = Math.max(0, -sinA - eps) ** DIRECTION_LOBE_POW;
  return { front, back, left, right };
}

function easeOutQuad(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - (1 - clamped) * (1 - clamped);
}

function peakAlphaForDamage(amount: number): number {
  if (amount <= 0) return 0;
  return Math.min(1, Math.pow(amount / PEAK_DAMAGE_REF, 0.85)) * PEAK_ALPHA_CAP;
}

function aggregateState(
  events: ActiveEvent[],
  nowMs: number,
  death: { active: boolean; deactivatedAtMs: number | null },
): DamageOverlayState {
  let front = 0;
  let back = 0;
  let left = 0;
  let right = 0;
  for (const event of events) {
    const age = nowMs - event.startedAtMs;
    const t = age / event.durationMs;
    if (t >= 1) continue;
    const fade = easeOutQuad(1 - t);
    const peak = peakAlphaForDamage(event.amount) * fade;
    front += event.weights.front * peak;
    back += event.weights.back * peak;
    left += event.weights.left * peak;
    right += event.weights.right * peak;
  }

  let deathAmt = 0;
  if (death.active) {
    deathAmt = DEATH_HOLD_PEAK;
  } else if (death.deactivatedAtMs != null) {
    const ageSinceClear = nowMs - death.deactivatedAtMs;
    if (ageSinceClear < DEATH_FADE_OUT_MS) {
      deathAmt = DEATH_HOLD_PEAK * (1 - ageSinceClear / DEATH_FADE_OUT_MS);
    }
  }

  if (deathAmt > 0) {
    front = Math.max(front, deathAmt);
  }

  front = Math.min(1, front);
  back = Math.min(1, back);
  left = Math.min(1, left);
  right = Math.min(1, right);
  const vignette = Math.min(1, Math.max(front, back, left, right) * VIGNETTE_GAIN);
  return { front, back, left, right, vignette, death: deathAmt };
}

function eventsActive(events: ActiveEvent[], nowMs: number): boolean {
  for (const event of events) {
    if (nowMs - event.startedAtMs < event.durationMs) return true;
  }
  return false;
}

function statesEqual(a: DamageOverlayState, b: DamageOverlayState): boolean {
  return (
    Math.abs(a.front - b.front) < 1e-3 &&
    Math.abs(a.back - b.back) < 1e-3 &&
    Math.abs(a.left - b.left) < 1e-3 &&
    Math.abs(a.right - b.right) < 1e-3 &&
    Math.abs(a.vignette - b.vignette) < 1e-3 &&
    Math.abs(a.death - b.death) < 1e-3
  );
}

export function useDamageFeedback(): {
  controller: DamageFeedbackController;
  renderState: DamageOverlayState;
} {
  const eventsRef = useRef<ActiveEvent[]>([]);
  const deathRef = useRef<{ active: boolean; deactivatedAtMs: number | null }>({
    active: false,
    deactivatedAtMs: null,
  });
  const lastStateRef = useRef<DamageOverlayState>(ZERO_STATE);
  const [renderState, setRenderState] = useState<DamageOverlayState>(ZERO_STATE);
  const rafRef = useRef<number | null>(null);

  const tick = useCallback(() => {
    const now = performance.now();
    const filtered = eventsRef.current.filter(
      (event) => now - event.startedAtMs < event.durationMs,
    );
    eventsRef.current = filtered;
    const next = aggregateState(filtered, now, deathRef.current);
    if (!statesEqual(next, lastStateRef.current)) {
      lastStateRef.current = next;
      setRenderState(next);
    }
    const stillActive =
      eventsActive(filtered, now) ||
      deathRef.current.active ||
      (deathRef.current.deactivatedAtMs != null &&
        now - deathRef.current.deactivatedAtMs < DEATH_FADE_OUT_MS);
    if (stillActive) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      rafRef.current = null;
    }
  }, []);

  const ensureLoop = useCallback(() => {
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [tick]);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  const pushEvent = useCallback(
    (input: DamageFeedbackInput) => {
      if (input.amount <= 0) return;
      const weights = input.weights ?? ZERO_WEIGHTS;
      eventsRef.current.push({
        amount: input.amount,
        weights: {
          front: weights.front,
          back: weights.back,
          left: weights.left,
          right: weights.right,
        },
        startedAtMs: input.startedAtMs ?? performance.now(),
        durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
      });
      ensureLoop();
    },
    [ensureLoop],
  );

  const setDead = useCallback(
    (dead: boolean) => {
      const cur = deathRef.current;
      if (dead === cur.active) return;
      if (dead) {
        deathRef.current = { active: true, deactivatedAtMs: null };
      } else {
        deathRef.current = { active: false, deactivatedAtMs: performance.now() };
      }
      ensureLoop();
    },
    [ensureLoop],
  );

  const reset = useCallback(() => {
    eventsRef.current = [];
    deathRef.current = { active: false, deactivatedAtMs: null };
    if (!statesEqual(ZERO_STATE, lastStateRef.current)) {
      lastStateRef.current = ZERO_STATE;
      setRenderState(ZERO_STATE);
    }
  }, []);

  const controllerRef = useRef<DamageFeedbackController>({ pushEvent, setDead, reset });
  controllerRef.current = { pushEvent, setDead, reset };

  return { controller: controllerRef.current, renderState };
}
