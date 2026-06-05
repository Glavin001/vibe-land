import { useEffect, useState } from 'react';
import {
  MAX_PRACTICE_BOTS,
  PRACTICE_BOT_SPRINT_DISTANCE_M,
  PRACTICE_BOT_SPRINT_SPEED,
  PRACTICE_BOT_WALK_SPEED,
  type BotDebugInfo,
  type PracticeBotBehaviorKind,
  type PracticeBotNavDebugConfig,
  type PracticeBotNavTuning,
  type PracticeBotRuntime,
  type PracticeBotStats,
} from '../bots';

interface PracticeBotsPanelProps {
  visible: boolean;
  desiredCount: number;
  stats: PracticeBotStats | null;
  runtime: PracticeBotRuntime | null;
  navConfig: PracticeBotNavDebugConfig | null;
  navTuning: PracticeBotNavTuning | null;
  debugOverlay: boolean;
  debugLabels: boolean;
  onSetBotCount: (count: number) => void;
  onClear: () => void;
  onSetBehavior: (kind: PracticeBotBehaviorKind) => void;
  onUpdateNavTuning: (patch: Partial<PracticeBotNavTuning>) => void;
  onResetNavTuning: () => void;
  onToggleDebugOverlay: (value: boolean) => void;
  onToggleDebugLabels: (value: boolean) => void;
  onSetEnableShooting: (value: boolean) => void;
  onSetEnableRecoveryLeash: (value: boolean) => void;
  onSetUseVehicles: (value: boolean) => void;
}

interface NavTuningDraft {
  walkableClimb: string;
  walkableSlopeAngleDegrees: string;
  cellHeight: string;
}

const BEHAVIORS: Array<{ value: PracticeBotBehaviorKind; label: string; desc: string }> = [
  { value: 'harass', label: 'Chase me', desc: 'Bots path toward the local player' },
  { value: 'wander', label: 'Wander', desc: 'Bots roam random walkable points' },
  { value: 'hold', label: 'Hold anchor', desc: 'Bots stay near their spawn anchor' },
];

function panelLabel(text: string) {
  return (
    <span className="w-16 shrink-0 text-[11px] uppercase tracking-[0.12em] text-white/60">
      {text}
    </span>
  );
}

export function PracticeBotsPanel({
  visible,
  desiredCount,
  stats,
  runtime,
  navConfig,
  navTuning,
  debugOverlay,
  debugLabels,
  onSetBotCount,
  onClear,
  onSetBehavior,
  onUpdateNavTuning,
  onResetNavTuning,
  onToggleDebugOverlay,
  onToggleDebugLabels,
  onSetEnableShooting,
  onSetEnableRecoveryLeash,
  onSetUseVehicles,
}: PracticeBotsPanelProps) {
  const [open, setOpen] = useState(false);
  const [botInfos, setBotInfos] = useState<BotDebugInfo[]>([]);
  const [navDraft, setNavDraft] = useState<NavTuningDraft | null>(null);
  const [navDraftDirty, setNavDraftDirty] = useState(false);
  const [countDraft, setCountDraft] = useState(() => String(desiredCount));

  const actualCount = stats?.bots ?? 0;
  const count = desiredCount;
  const behavior = stats?.behavior ?? 'harass';
  const maxSpeed = stats?.maxSpeed ?? PRACTICE_BOT_SPRINT_SPEED;
  const activeNav = navConfig;
  const enableShooting = stats?.enableShooting ?? true;
  const enableRecoveryLeash = stats?.enableRecoveryLeash ?? false;
  const useVehicles = stats?.useVehicles ?? false;

  useEffect(() => {
    if (!visible || !open || !runtime || !debugOverlay) {
      setBotInfos([]);
      return;
    }
    const sync = () => {
      const next = runtime
        .getBotDebugInfos()
        .slice()
        .sort((a, b) => a.id - b.id);
      setBotInfos(next);
    };
    sync();
    const interval = setInterval(sync, 250);
    return () => clearInterval(interval);
  }, [debugOverlay, open, runtime, visible]);

  useEffect(() => {
    setCountDraft(String(desiredCount));
  }, [desiredCount]);

  useEffect(() => {
    if (!navConfig) {
      setNavDraft(null);
      setNavDraftDirty(false);
      return;
    }
    if (navDraftDirty) {
      return;
    }
    setNavDraft({
      walkableClimb: navConfig.walkableClimb.toFixed(3),
      walkableSlopeAngleDegrees: navConfig.walkableSlopeAngleDegrees.toFixed(0),
      cellHeight: navConfig.cellHeight.toFixed(4),
    });
  }, [
    navConfig?.walkableClimb,
    navConfig?.walkableSlopeAngleDegrees,
    navConfig?.cellHeight,
    navDraftDirty,
  ]);

  if (!visible) return null;

  return (
    <div className="absolute right-2 top-12 z-[12] flex flex-col items-end gap-1 font-sans text-white">
      <button
        type="button"
        className="min-w-28 rounded-md border border-white/[0.12] bg-black/60 px-3 py-1.5 text-left text-xs text-white shadow-[0_8px_18px_rgba(0,0,0,0.3)] backdrop-blur-sm transition-colors hover:bg-black/[0.72]"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? '▼ Bots' : '▶ Bots'} · {actualCount}
      </button>
      {open && (
        <div className="flex max-h-[calc(100vh-4.5rem)] min-w-[22.5rem] max-w-[34rem] flex-col gap-3 overflow-y-auto rounded-xl border border-white/[0.12] bg-black/70 px-3 py-3 shadow-[0_14px_36px_rgba(0,0,0,0.42)] backdrop-blur-md">
          <div className="flex items-center gap-2 text-xs">
            {panelLabel('Count')}
            <input
              type="range"
              min={0}
              max={MAX_PRACTICE_BOTS}
              step={1}
              value={count}
              className="h-2 flex-1 cursor-pointer accent-sky-300"
              onInput={(event) => onSetBotCount(Number((event.target as HTMLInputElement).value))}
              onChange={(event) => onSetBotCount(Number(event.target.value))}
            />
            <input
              type="number"
              min={0}
              max={MAX_PRACTICE_BOTS}
              step={1}
              value={countDraft}
              className="w-14 rounded border border-white/20 bg-white/10 px-1.5 py-0.5 text-right text-xs text-white outline-none transition focus:border-sky-300/60 focus:bg-white/12"
              onInput={(event) => {
                const nextRaw = (event.target as HTMLInputElement).value;
                setCountDraft(nextRaw);
                const next = Number.parseInt(nextRaw, 10);
                if (Number.isFinite(next)) onSetBotCount(next);
              }}
              onBlur={() => setCountDraft(String(desiredCount))}
            />
          </div>
          <div className="flex items-center gap-2 text-xs">
            {panelLabel('Move')}
            <div className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-2 text-white/[0.82]">
              Human speeds: walk {PRACTICE_BOT_WALK_SPEED.toFixed(1)} m/s, sprint {PRACTICE_BOT_SPRINT_SPEED.toFixed(1)} m/s.
              Sprint engages when the target is more than {PRACTICE_BOT_SPRINT_DISTANCE_M.toFixed(0)} m away.
            </div>
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
            {panelLabel('Combat')}
            <label className="flex flex-1 cursor-pointer items-center gap-2 text-white/[0.85]">
              <input
                type="checkbox"
                checked={enableShooting}
                onChange={(event) => onSetEnableShooting(event.target.checked)}
                className="accent-sky-300"
              />
              <span>bots can fire their weapons</span>
            </label>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {panelLabel('Leash')}
            <label className="flex flex-1 cursor-pointer items-center gap-2 text-white/[0.85]">
              <input
                type="checkbox"
                checked={enableRecoveryLeash}
                onChange={(event) => onSetEnableRecoveryLeash(event.target.checked)}
                className="accent-sky-300"
              />
              <span>return bots to their spawn anchor if they stray too far</span>
            </label>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {panelLabel('Vehicles')}
            <label className="flex flex-1 cursor-pointer items-center gap-2 text-white/[0.85]">
              <input
                type="checkbox"
                checked={useVehicles}
                onChange={(event) => onSetUseVehicles(event.target.checked)}
                className="accent-sky-300"
              />
              <span>bots can drive vehicles to reach targets</span>
            </label>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {panelLabel('Debug')}
            <div className="flex flex-1 flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-white/[0.85]">
                <input
                  type="checkbox"
                  checked={debugOverlay}
                  onChange={(event) => onToggleDebugOverlay(event.target.checked)}
                  className="accent-sky-300"
                />
                <span>Show navmesh, raw and snapped targets, and paths in scene</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-white/[0.85]">
                <input
                  type="checkbox"
                  checked={debugLabels}
                  onChange={(event) => onToggleDebugLabels(event.target.checked)}
                  className="accent-sky-300"
                />
                <span>Show floating bot detail cards above bots</span>
              </label>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              className="flex-1 rounded-md border border-sky-300/[0.45] bg-sky-300/[0.18] px-3 py-1.5 font-medium text-sky-50 transition-colors hover:bg-sky-300/[0.26]"
              onClick={() => onSetBotCount(count + 1)}
              disabled={count >= MAX_PRACTICE_BOTS}
            >
              + Add bot
            </button>
            <button
              type="button"
              className="flex-1 rounded-md border border-red-300/[0.4] bg-red-300/[0.16] px-3 py-1.5 font-medium text-red-50 transition-colors enabled:hover:bg-red-300/[0.24] disabled:cursor-not-allowed disabled:opacity-45"
              onClick={onClear}
              disabled={actualCount === 0}
            >
              Clear
            </button>
          </div>
          <div className="flex items-center gap-2 border-t border-dashed border-white/10 pt-2 font-mono text-[11px] text-white/[0.68]">
            <span>{actualCount} live / {desiredCount} target</span>
            <span>·</span>
            <span>{PRACTICE_BOT_WALK_SPEED.toFixed(1)} / {maxSpeed.toFixed(1)} m/s</span>
            <span>·</span>
            <span>{behavior}</span>
          </div>
          <div className="border-t border-white/[0.08] pt-2">
            <div className="mb-2 flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.12em] text-white/[0.58]">
              <span>Nav Tuning</span>
              <div className="flex items-center gap-2">
                {navTuning && (
                  <span className="rounded bg-cyan-300/12 px-1.5 py-0.5 text-[10px] text-cyan-200">
                    override
                  </span>
                )}
                <button
                  type="button"
                  className="rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] text-white/72 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => {
                    if (!navConfig) return;
                    setNavDraftDirty(false);
                    setNavDraft({
                      walkableClimb: navConfig.walkableClimb.toFixed(3),
                      walkableSlopeAngleDegrees: navConfig.walkableSlopeAngleDegrees.toFixed(0),
                      cellHeight: navConfig.cellHeight.toFixed(4),
                    });
                  }}
                  disabled={!navConfig}
                >
                  revert draft
                </button>
                <button
                  type="button"
                  className="rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] text-white/72 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={onResetNavTuning}
                  disabled={!navTuning}
                >
                  shared defaults
                </button>
              </div>
            </div>
            {activeNav && navDraft ? (
              <div className="space-y-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 font-mono text-[11px] text-white/[0.82]">
                <div className="grid grid-cols-[5.6rem_1fr] gap-x-2 gap-y-1">
                  <DebugKeyValue label="mode" value={activeNav.mode} />
                  <DebugKeyValue label="radius" value={`${activeNav.walkableRadius.toFixed(2)} m`} />
                  <DebugKeyValue label="height" value={`${activeNav.walkableHeight.toFixed(2)} m`} />
                  <DebugKeyValue label="cell size" value={`${activeNav.cellSize.toFixed(4)} m`} />
                  <DebugKeyValue label="tile" value={`${activeNav.tileSizeVoxels} vox`} />
                  <DebugKeyValue
                    label="snap box"
                    value={`[${activeNav.snapHalfExtents.map((v) => v.toFixed(2)).join(', ')}]`}
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <NavInput
                    label="climb"
                    value={navDraft.walkableClimb}
                    unit="m"
                    onChange={(value) => setNavDraft((current) => current ? {
                      ...current,
                      walkableClimb: value,
                    } : current)}
                    onDirtyChange={setNavDraftDirty}
                  />
                  <NavInput
                    label="slope"
                    value={navDraft.walkableSlopeAngleDegrees}
                    unit="deg"
                    onChange={(value) => setNavDraft((current) => current ? {
                      ...current,
                      walkableSlopeAngleDegrees: value,
                    } : current)}
                    onDirtyChange={setNavDraftDirty}
                  />
                  <NavInput
                    label="cell h"
                    value={navDraft.cellHeight}
                    unit="m"
                    onChange={(value) => setNavDraft((current) => current ? {
                      ...current,
                      cellHeight: value,
                    } : current)}
                    onDirtyChange={setNavDraftDirty}
                  />
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-white/[0.08] pt-2">
                  <div className="text-[10px] text-white/[0.48]">
                    Active: climb {activeNav.walkableClimb.toFixed(3)} m · slope {activeNav.walkableSlopeAngleDegrees.toFixed(0)} deg · cell h {activeNav.cellHeight.toFixed(4)} m
                    {' '}· keeps current bots
                  </div>
                  <button
                    type="button"
                    className="rounded border border-cyan-300/[0.38] bg-cyan-300/[0.14] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-cyan-100 transition hover:bg-cyan-300/[0.22] disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => {
                      const climb = Number(navDraft.walkableClimb);
                      const slope = Number(navDraft.walkableSlopeAngleDegrees);
                      const cellHeight = Number(navDraft.cellHeight);
                      if (!Number.isFinite(climb) || !Number.isFinite(slope) || !Number.isFinite(cellHeight)) {
                        return;
                      }
                      onUpdateNavTuning({
                        walkableClimb: climb,
                        walkableSlopeAngleDegrees: slope,
                        cellHeight,
                      });
                      setNavDraftDirty(false);
                    }}
                    disabled={!isValidNavDraft(navDraft)}
                  >
                    Apply nav rebuild
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[11px] text-white/[0.5]">
                Building navmesh config…
              </div>
            )}
          </div>
          <div className="border-t border-white/[0.08] pt-2">
            <div className="mb-2 flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.12em] text-white/[0.58]">
              <span>Bot Debug Feed</span>
              <span>{botInfos.length} live</span>
            </div>
            {runtime ? (
              botInfos.length > 0 ? (
                <div className="max-h-[26rem] space-y-2 overflow-y-auto pr-1">
                  {botInfos.map((info) => (
                    <BotDebugCard key={info.id} info={info} />
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[11px] text-white/[0.5]">
                  No bot debug samples yet.
                </div>
              )
            ) : (
              <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[11px] text-white/[0.5]">
                Practice bot runtime unavailable.
              </div>
            )}
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

function NavInput({
  label,
  value,
  unit,
  onChange,
  onDirtyChange,
}: {
  label: string;
  value: string;
  unit: string;
  onChange: (value: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  return (
    <label className="rounded border border-white/[0.08] bg-black/20 px-2 py-2">
      <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-white/48">{label}</div>
      <div className="flex items-center gap-1">
        <input
          type="text"
          inputMode="decimal"
          spellCheck={false}
          value={value}
          className="w-full rounded border border-white/14 bg-white/[0.06] px-2 py-1 text-right text-[11px] text-white outline-none transition focus:border-cyan-300/60 focus:bg-white/[0.09]"
          onChange={(event) => {
            onDirtyChange(true);
            onChange(event.target.value);
          }}
        />
        <span className="text-[10px] uppercase tracking-[0.08em] text-white/45">{unit}</span>
      </div>
    </label>
  );
}

function isValidNavDraft(draft: NavTuningDraft | null): boolean {
  if (!draft) return false;
  const climb = Number(draft.walkableClimb);
  const slope = Number(draft.walkableSlopeAngleDegrees);
  const cellHeight = Number(draft.cellHeight);
  return Number.isFinite(climb)
    && Number.isFinite(slope)
    && Number.isFinite(cellHeight)
    && climb >= 0
    && slope > 0
    && slope < 90
    && cellHeight > 0;
}

function BotDebugCard({ info }: { info: BotDebugInfo }) {
  const speed = Math.hypot(info.velocity[0], info.velocity[2]);
  const desiredSpeed = Math.hypot(info.desiredVelocity[0], info.desiredVelocity[2]);
  const botNumber = info.id - 1_000_000 + 1;
  const targetTone = info.lastMoveAccepted === false
    ? 'text-rose-300'
    : info.targetPlayerId !== null
      ? 'text-cyan-200'
      : 'text-white/80';

  return (
    <article className="rounded-lg border border-white/[0.08] bg-white/[0.035] px-3 py-2 font-mono text-[11px] text-white/[0.82]">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/75">
            bot {botNumber}
          </span>
          <span className="text-[10px] uppercase tracking-[0.12em] text-white/55">
            {info.behaviorKind}
          </span>
        </div>
        <span className="text-[10px] uppercase tracking-[0.12em] text-white/55">
          {info.mode}
        </span>
      </div>
      <div className="grid grid-cols-[4.8rem_1fr] gap-x-2 gap-y-1">
        <DebugKeyValue label="Target" value={describePanelTarget(info)} valueClassName={targetTone} />
        <DebugKeyValue label="Move" value={describePanelMove(info)} />
        <DebugKeyValue label="Snap" value={describePanelSnap(info)} />
        <DebugKeyValue
          label="Speed"
          value={`${speed.toFixed(2)} / ${desiredSpeed.toFixed(2)} / ${info.maxSpeed.toFixed(2)} m/s`}
        />
        <DebugKeyValue label="Pos" value={formatVec3(info.position)} />
        <DebugKeyValue label="Raw" value={formatVec3(info.rawTarget)} />
        <DebugKeyValue label="Snapped" value={formatVec3(info.target)} />
        <DebugKeyValue label="Desired" value={formatVec3(info.desiredVelocity)} />
        <DebugKeyValue
          label="Path"
          value={`${Math.max(0, info.pathPoints.length - 1)} segments`}
        />
      </div>
    </article>
  );
}

function DebugKeyValue({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <>
      <span className="text-[10px] uppercase tracking-[0.12em] text-white/42">{label}</span>
      <span className={valueClassName ?? 'text-white/82'}>{value}</span>
    </>
  );
}

function formatVec3(value: [number, number, number] | null): string {
  if (!value) return '—';
  return `[${value[0].toFixed(1)}, ${value[1].toFixed(1)}, ${value[2].toFixed(1)}]`;
}

function describePanelTarget(info: BotDebugInfo): string {
  if (info.targetPlayerId !== null) {
    return `player #${info.targetPlayerId}`;
  }
  if (info.rawTarget) {
    const dx = info.rawTarget[0] - info.position[0];
    const dz = info.rawTarget[2] - info.position[2];
    return `${Math.hypot(dx, dz).toFixed(1)}m from bot`;
  }
  return '—';
}

function describePanelMove(info: BotDebugInfo): string {
  const move = info.lastMoveAccepted == null ? '—' : (info.lastMoveAccepted ? 'accepted' : 'rejected');
  return `${move} · ${info.ticksSinceReplan}t`;
}

function describePanelSnap(info: BotDebugInfo): string {
  if (!info.rawTarget) return 'no raw target';
  if (!info.target) return 'no snapped target';
  return `${(info.targetSnapDistanceM ?? 0).toFixed(2)}m`;
}
