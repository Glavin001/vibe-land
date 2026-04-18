import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PracticeBotBehaviorKind, PracticeBotStats } from '../bots';

interface PracticeBotsPanelProps {
  visible: boolean;
  stats: PracticeBotStats | null;
  debugOverlay: boolean;
  onSetBotCount: (count: number) => void;
  onClear: () => void;
  onSetBehavior: (kind: PracticeBotBehaviorKind) => void;
  onSetMaxSpeed: (speed: number) => void;
  onToggleDebugOverlay: (value: boolean) => void;
}

const BEHAVIORS: Array<{ value: PracticeBotBehaviorKind; label: string; desc: string }> = [
  { value: 'harass', label: 'Chase me', desc: 'Bots path toward the local player' },
  { value: 'wander', label: 'Wander', desc: 'Bots roam random walkable points' },
  { value: 'hold', label: 'Hold anchor', desc: 'Bots stay near their spawn anchor' },
];

function useDraggableInputSync(
  externalValue: number,
): readonly [
  RefObject<HTMLInputElement>,
  () => void,
  () => void,
] {
  const ref = useRef<HTMLInputElement>(null);
  const draggingRef = useRef(false);
  useEffect(() => {
    if (draggingRef.current || !ref.current) return;
    const next = String(externalValue);
    if (ref.current.value !== next) {
      ref.current.value = next;
    }
  }, [externalValue]);
  const onPointerDown = () => {
    draggingRef.current = true;
  };
  const onPointerUp = () => {
    draggingRef.current = false;
  };
  return [ref, onPointerDown, onPointerUp];
}

function panelLabel(text: string) {
  return (
    <span className="w-16 shrink-0 text-[11px] uppercase tracking-[0.12em] text-white/60">
      {text}
    </span>
  );
}

export function PracticeBotsPanel({
  visible,
  stats,
  debugOverlay,
  onSetBotCount,
  onClear,
  onSetBehavior,
  onSetMaxSpeed,
  onToggleDebugOverlay,
}: PracticeBotsPanelProps) {
  const [open, setOpen] = useState(false);

  const count = stats?.bots ?? 0;
  const behavior = stats?.behavior ?? 'harass';
  const maxSpeed = stats?.maxSpeed ?? 3.0;

  const [countSliderRef, countDragStart, countDragEnd] = useDraggableInputSync(count);
  const [countNumberRef] = useDraggableInputSync(count);
  const [speedSliderRef, speedDragStart, speedDragEnd] = useDraggableInputSync(maxSpeed);
  const [speedNumberRef] = useDraggableInputSync(maxSpeed);

  if (!visible) return null;

  return (
    <div className="absolute right-2 top-12 z-[12] flex flex-col items-end gap-1 font-sans text-white">
      <button
        type="button"
        className="min-w-28 rounded-md border border-white/[0.12] bg-black/60 px-3 py-1.5 text-left text-xs text-white shadow-[0_8px_18px_rgba(0,0,0,0.3)] backdrop-blur-sm transition-colors hover:bg-black/[0.72]"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? '▼ Bots' : '▶ Bots'} · {count}
      </button>
      {open && (
        <div className="flex min-w-[22.5rem] flex-col gap-3 rounded-xl border border-white/[0.12] bg-black/70 px-3 py-3 shadow-[0_14px_36px_rgba(0,0,0,0.42)] backdrop-blur-md">
          <div className="flex items-center gap-2 text-xs">
            {panelLabel('Count')}
            <input
              ref={countSliderRef}
              type="range"
              min={0}
              max={16}
              step={1}
              defaultValue={count}
              className="h-2 flex-1 cursor-pointer accent-sky-300"
              onInput={(event) => onSetBotCount(Number((event.target as HTMLInputElement).value))}
              onPointerDown={countDragStart}
              onPointerUp={countDragEnd}
              onPointerCancel={countDragEnd}
            />
            <input
              ref={countNumberRef}
              type="number"
              min={0}
              max={32}
              step={1}
              defaultValue={count}
              className="w-14 rounded border border-white/20 bg-white/10 px-1.5 py-0.5 text-right text-xs text-white outline-none transition focus:border-sky-300/60 focus:bg-white/12"
              onChange={(event) => {
                const next = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(next)) onSetBotCount(next);
              }}
            />
          </div>
          <div className="flex items-center gap-2 text-xs">
            {panelLabel('Speed')}
            <input
              ref={speedSliderRef}
              type="range"
              min={0.5}
              max={8}
              step={0.25}
              defaultValue={maxSpeed}
              className="h-2 flex-1 cursor-pointer accent-sky-300"
              onInput={(event) => onSetMaxSpeed(Number((event.target as HTMLInputElement).value))}
              onPointerDown={speedDragStart}
              onPointerUp={speedDragEnd}
              onPointerCancel={speedDragEnd}
            />
            <input
              ref={speedNumberRef}
              type="number"
              min={0.5}
              max={12}
              step={0.25}
              defaultValue={maxSpeed}
              className="w-14 rounded border border-white/20 bg-white/10 px-1.5 py-0.5 text-right text-xs text-white outline-none transition focus:border-sky-300/60 focus:bg-white/12"
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next) && next > 0) onSetMaxSpeed(next);
              }}
            />
            <span className="w-8 text-[11px] text-white/55">m/s</span>
          </div>
          <div className="flex items-start gap-2 text-xs">
            {panelLabel('Behavior')}
            <div className="flex flex-1 flex-col gap-1">
              {BEHAVIORS.map((option) => {
                const checked = behavior === option.value;
                return (
                  <label
                    key={option.value}
                    className={[
                      'flex cursor-pointer gap-2 rounded-lg border px-2 py-1.5 transition-colors',
                      checked
                        ? 'border-sky-300/[0.4] bg-sky-300/10'
                        : 'border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06]',
                    ].join(' ')}
                  >
                    <input
                      type="radio"
                      name="practice-bot-behavior"
                      value={option.value}
                      checked={checked}
                      onChange={() => onSetBehavior(option.value)}
                      className="mt-[1px] accent-sky-300"
                    />
                    <span className="leading-4">
                      <span className="font-semibold text-white/[0.92]">{option.label}</span>
                      <span className="ml-1 text-[11px] text-white/[0.55]">{option.desc}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {panelLabel('Debug')}
            <label className="flex flex-1 cursor-pointer items-center gap-2 text-white/[0.85]">
              <input
                type="checkbox"
                checked={debugOverlay}
                onChange={(event) => onToggleDebugOverlay(event.target.checked)}
                className="accent-sky-300"
              />
              <span>Show navmesh, raw and snapped targets, paths, and state labels in scene</span>
            </label>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              className="flex-1 rounded-md border border-sky-300/[0.45] bg-sky-300/[0.18] px-3 py-1.5 font-medium text-sky-50 transition-colors hover:bg-sky-300/[0.26]"
              onClick={() => onSetBotCount(count + 1)}
            >
              + Add bot
            </button>
            <button
              type="button"
              className="flex-1 rounded-md border border-red-300/[0.4] bg-red-300/[0.16] px-3 py-1.5 font-medium text-red-50 transition-colors enabled:hover:bg-red-300/[0.24] disabled:cursor-not-allowed disabled:opacity-45"
              onClick={onClear}
              disabled={count === 0}
            >
              Clear
            </button>
          </div>
          <div className="flex items-center gap-2 border-t border-dashed border-white/10 pt-2 font-mono text-[11px] text-white/[0.68]">
            <span>{count} bots</span>
            <span>·</span>
            <span>{maxSpeed.toFixed(2)} m/s</span>
            <span>·</span>
            <span>{behavior}</span>
          </div>
          <div className="border-t border-white/[0.08] pt-2 text-[11px] text-white/[0.48]">
            {stats
              ? `navmesh: ${stats.navTriangles.toLocaleString()} tris · bots run as real local-session players`
              : 'Building practice bot navmesh…'}
          </div>
        </div>
      )}
    </div>
  );
}
