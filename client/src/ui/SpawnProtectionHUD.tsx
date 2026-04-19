import { useEffect, useRef, useState } from 'react';
import { SPAWN_PROTECTION_MS } from '../net/protocol';

type SpawnProtectionHUDProps = {
  protectedActive: boolean;
  visible: boolean;
};

const TICK_MS = 50;

export function SpawnProtectionHUD({ protectedActive, visible }: SpawnProtectionHUDProps) {
  const deadlineRef = useRef<number | null>(null);
  const [nowMs, setNowMs] = useState(() => performance.now());

  useEffect(() => {
    if (!visible || !protectedActive) {
      deadlineRef.current = null;
      return;
    }
    if (deadlineRef.current == null) {
      deadlineRef.current = performance.now() + SPAWN_PROTECTION_MS;
    }
  }, [protectedActive, visible]);

  useEffect(() => {
    if (!visible || !protectedActive) {
      return;
    }
    const timer = window.setInterval(() => {
      setNowMs(performance.now());
    }, TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [protectedActive, visible]);

  if (!visible || !protectedActive || deadlineRef.current == null) {
    return null;
  }

  const remainingSec = Math.max(0, (deadlineRef.current - nowMs) / 1000);

  return (
    <div className="pointer-events-none absolute left-4 bottom-[5.75rem] z-[15] select-none rounded-lg border border-sky-300/40 bg-sky-500/[0.14] px-3 py-2 text-[#d9f3ff] shadow-[0_0_22px_rgba(82,184,255,0.14)] backdrop-blur-md">
      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-sky-100/85">
        You are invulnerable for
      </div>
      <div className="font-mono text-[20px] font-extrabold tracking-[0.05em] text-sky-200 [text-shadow:0_0_16px_rgba(82,184,255,0.38)]">
        {remainingSec.toFixed(1)}s
      </div>
    </div>
  );
}
