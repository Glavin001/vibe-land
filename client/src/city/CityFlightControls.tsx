import { useEffect } from 'react';
import { keyboardCodeLabel, type InputBindings } from '../input/bindings';

type Props = {
  active: boolean;
  speed: number;
  onActiveChange: (active: boolean) => void;
  onSpeedChange: (speed: number) => void;
  bindings: InputBindings;
  touch: boolean;
};

export function CityFlightControls({ active, speed, onActiveChange, onSpeedChange, bindings, touch }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'KeyN' || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement
        && (target.isContentEditable || target.closest('input, textarea, select, button, a, [role="dialog"]'))) return;
      event.preventDefault();
      onActiveChange(!active);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onActiveChange]);

  const keys = bindings.keyboard;
  return (
    <section
      aria-label="Aerial camera controls"
      className="absolute right-3 top-14 z-12 max-w-[calc(100%-24px)] rounded-xl border border-white/15 bg-slate-950/85 p-3 text-white shadow-lg backdrop-blur"
      style={{ width: active ? 280 : undefined }}
    >
      <button
        type="button"
        aria-pressed={active}
        data-testid="city-flight-toggle"
        className="flex w-full items-center justify-between gap-4 rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-cyan-300"
        onClick={(event) => { event.currentTarget.blur(); onActiveChange(!active); }}
      >
        <span>{active ? 'Return to player' : 'Fly camera'}</span>
        {!touch && <kbd className="text-xs text-cyan-200">N</kbd>}
      </button>
      {active && (
        <div className="mt-3 space-y-3 text-xs text-slate-300">
          <div>
            <p className="mb-1 font-semibold text-cyan-200">Aerial view</p>
            <p>Explore freely. Your player stays below.</p>
          </div>
          <p>
            {touch
              ? 'Stick to move · drag to look · jump to rise · crouch to descend'
              : `${keyboardCodeLabel(keys.moveForward)}/${keyboardCodeLabel(keys.moveLeft)}/${keyboardCodeLabel(keys.moveBackward)}/${keyboardCodeLabel(keys.moveRight)} move · mouse look`}
          </p>
          {!touch && <p>{keyboardCodeLabel(keys.jump)} rise · {keyboardCodeLabel(keys.crouch)} descend · {keyboardCodeLabel(keys.sprint)} boost</p>}
          <label className="block">
            <span className="flex justify-between"><span>Flight speed</span><output>{speed} m/s</output></span>
            <input
              aria-label="Flight speed"
              className="mt-2 w-full accent-cyan-300"
              type="range" min="5" max="100" step="5" value={speed}
              onChange={(event) => onSpeedChange(Number(event.target.value))}
            />
          </label>
          {!touch && <p className="text-slate-400">Click the city to fly · Esc releases the mouse</p>}
        </div>
      )}
    </section>
  );
}
