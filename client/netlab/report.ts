/**
 * Markdown report rendering for netlab verdicts.
 */

import type { IterationVerdict } from './analyze';
import type { GateOutcome } from './thresholds';

function verdictBadge(v: string): string {
  return v === 'fail' ? '❌ FAIL' : v === 'warn' ? '⚠️ warn' : '✅ pass';
}

function fmt(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

function gateRow(g: GateOutcome): string {
  const gate = g.gate ? `warn ≥ ${g.gate.warn.toFixed(1)}, fail ≥ ${g.gate.fail.toFixed(1)} ${g.gate.unit}` : '—';
  return `| ${g.metric} | ${fmt(g.value, 2)} | ${gate} | ${verdictBadge(g.verdict)} |`;
}

export function renderReport(v: IterationVerdict): string {
  const run = v.runInfo as {
    scenario?: string;
    matchId?: string;
    startedAtIso?: string;
    impairment?: { profile: string | null; mode: string; seed: number };
    environment?: Record<string, unknown>;
  };
  const lines: string[] = [];
  lines.push(`# netlab report — ${run.scenario ?? 'unknown scenario'}`);
  lines.push('');
  lines.push(`- match: \`${run.matchId}\`  started: ${run.startedAtIso}`);
  const imp = run.impairment;
  lines.push(
    `- impairment: ${imp?.profile ? `**${imp.profile}** (${imp.mode}, seed ${imp.seed})` : 'none (baseline)'}`,
  );
  const env = run.environment ?? {};
  lines.push(
    `- build: server \`${env.serverBuild ?? '?'}\` git \`${env.gitRev ?? '?'}\` · GPU: ${String(env.gpuRenderer ?? '?').slice(0, 80)}`,
  );
  lines.push('');

  // ---- Attribution first: this is the answer to "whose fault is it" -------
  lines.push('## Layer attribution');
  lines.push('');
  for (const f of v.attribution) {
    lines.push(`### ${f.channel}: ${f.status}${f.score > 0 ? ` (score ${f.score})` : ''}`);
    for (const e of f.evidence) lines.push(`- ${e}`);
    if (f.evidence.length === 0) lines.push('- no findings');
    lines.push('');
  }

  if (v.taggedEvents.length > 0) {
    lines.push('## Artifact events with proximate causes');
    lines.push('');
    lines.push('| t (ms) | event | magnitude (m) | proximate cause |');
    lines.push('|---|---|---|---|');
    for (const e of v.taggedEvents.slice(0, 50)) {
      lines.push(`| ${e.tMs.toFixed(0)} | ${e.type} | ${e.magnitude.toFixed(3)} | ${e.proximateCause} |`);
    }
    if (v.taggedEvents.length > 50) lines.push(`| … | ${v.taggedEvents.length - 50} more | | |`);
    lines.push('');
  }

  // ---- Per-client gates ---------------------------------------------------
  for (const client of v.clients) {
    const m = client.metrics;
    lines.push(`## client${m.clientIndex} (${m.role}) — ${client.failCount} fail / ${client.warnCount} warn`);
    lines.push('');
    lines.push(
      `${m.frames} frames over ${fmt(m.durationS)}s at ${fmt(m.fpsMean, 0)} fps mean · ping p95 ${fmt(m.pingP95Ms)}ms · snapshot cadence ${fmt(m.snapshotCadenceMs)}ms (p50 gap ${fmt(m.snapshotGapP50Ms)}ms)`,
    );
    lines.push('');
    lines.push('| metric | value | gate | verdict |');
    lines.push('|---|---|---|---|');
    for (const g of client.gates) lines.push(gateRow(g));
    lines.push('');
    lines.push(
      `Ungated context: renderAccelRms p99 ${fmt(m.renderAccelRmsP99)} m/s² · presOff tail ${fmt(m.presOffP95CmP99)}cm (max ${fmt(m.presOffMaxCm)}cm — includes prediction lead in full-prediction mode) · clock drift ${fmt(m.clockDriftUsPerS, 0)} µs/s · pending inputs max ${fmt(m.pendingInputsMax, 0)}`,
    );
    if (m.city) {
      const c = m.city;
      lines.push(
        `City: ${c.chunksTotal} chunks · peak ${c.peakAwake} awake bodies / ${c.peakLiveIslands} islands / ${c.peakBrokenBonds} broken bonds · bandwidth peak ${fmt(c.peakMbps, 2)} Mbps, settled ${fmt(c.steadyMbps, 3)} Mbps`,
      );
      lines.push(
        `City frame cost: gap p99 ${fmt(c.frameGapP99BusyMs)}ms while busy (>500 awake, ${c.busyFrames} frames) vs ${fmt(c.frameGapP99IdleMs)}ms while settled · chunk recompose p95 worst ${fmt(c.chunkUpdateP95MaxMs, 2)}ms`,
      );
      lines.push(`City screen freshness: standing stale ${c.staleDrawnChunksFinal} (worst transient ${c.staleDrawnChunksMax}) chunks drawn >0.5 m from the ledger · ${c.floatingSettledIslandsFinal} settled islands hovering unsupported (physics verdict, not netcode) · largest island ${c.largestIslandChunksPeak} chunks peak -> ${c.largestIslandChunksFinal} final`);
      const a = c.anomalies;
      lines.push(
        `City pose anomalies: ${fmt(a.chunkTeleportsPerMin)} chunk teleports/min (worst ${fmt(a.chunkTeleportMaxM, 2)}m) · ${fmt(a.snapsPerMin)} snaps/min (worst ${fmt(a.snapMaxM, 2)}m, ${fmt(a.snapsDuringStarvationPct, 0)}% during record starvation) · ${fmt(a.clockRollbacksPerMin, 0)} clock rollbacks/min (worst ${fmt(a.clockRollbackMaxTicks)} ticks; ${fmt(a.clockRollbacksWithCorrectionPct, 0)}% dropped a live correction, worst ${fmt(a.clockRollbackAbandonedMaxM, 3)}m) · ${fmt(a.implausibleJumpsPerMin)} implausible knot jumps/min`,
      );
      lines.push(
        `City invariants: ${a.flickerBodies} flickering bodies · ${a.membershipViolations} membership violations · ${a.migrateMissingDestination}/${a.migrateEmptyDestination} migrate missing/empty destination · ${a.settleRollbacks} settle rollbacks · ${a.corruptFrames} corrupt frames`,
      );
    }
    if (m.remote) {
      lines.push(
        `Observer view: ${m.remote.samples} samples of watched player · ${m.remote.teleportSteps} teleport steps · frozen ${fmt(m.remote.freezePct, 2)}% · accelRms p99 ${fmt(m.remote.accelRmsP99)} m/s²`,
      );
    }
    lines.push('');
  }

  // ---- Server -------------------------------------------------------------
  lines.push('## Server');
  lines.push('');
  if (v.server) {
    const s = v.server;
    lines.push(
      `${s.samples} stat samples · sim ${s.simHz}Hz / snapshots ${s.snapshotHz}Hz · tick p95 peak ${fmt(s.tickP95MaxMs, 2)}ms (budget ${fmt(s.tickBudgetMs)}ms, worst ${fmt(s.tickMaxMs, 2)}ms) · one-way max ${fmt(s.oneWayMaxMs)}ms · input jitter max ${fmt(s.inputJitterMaxMs)}ms`,
    );
    lines.push(
      `real-time pace: ${fmt(s.measuredTickHz, 2)}Hz measured vs ${s.simHz}Hz nominal (${fmt(s.tickDeficitPct, 2)}% tick deficit) · longest stats-feed gap ${fmt(s.statsGapMaxMs, 0)}ms`,
    );
    lines.push(
      `drops: strict ${s.strictSnapshotDrops}, outbound snapshots ${s.droppedOutboundSnapshots}, malformed ${s.malformedPackets}`,
    );
  } else {
    lines.push('no server stats captured');
  }
  lines.push('');
  return lines.join('\n');
}

/** Compact console summary line per iteration. */
export function summaryLine(v: IterationVerdict): string {
  const fails = v.clients.reduce((sum, c) => sum + c.failCount, 0);
  const warns = v.clients.reduce((sum, c) => sum + c.warnCount, 0);
  const top = v.attribution.filter((f) => f.status === 'DEGRADED').map((f) => f.channel);
  return `${fails} fail / ${warns} warn · degraded: ${top.length ? top.join(', ') : 'none'}`;
}
