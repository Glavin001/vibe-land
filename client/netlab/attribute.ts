/**
 * Layer attribution: reduce the evidence to four channels — RENDER, NETWORK,
 * SERVER, SYNC — and emit a ranked list of findings with the evidence lines
 * that support each. Emitted as a ranked list, not a forced single verdict:
 * real incidents often span layers (e.g. sync fragility exposed by transport
 * stress), and hiding the second-place channel would hide the story.
 */

import type { ClientMetrics, ServerMetrics } from './analyze';
import { ABSOLUTE_GATES } from './thresholds';

export type Channel = 'RENDER' | 'NETWORK' | 'SERVER' | 'SYNC';

export interface ChannelFinding {
  channel: Channel;
  status: 'OK' | 'DEGRADED';
  score: number;
  evidence: string[];
}

export interface AttributionInput {
  clients: ClientMetrics[];
  server: ServerMetrics | null;
  impairment: { profile: string | null; mode: string } | null;
}

export function attribute(input: AttributionInput): ChannelFinding[] {
  const findings: ChannelFinding[] = [];
  const impaired = Boolean(input.impairment?.profile);

  // --- RENDER: frame pacing bad while snapshots arrive on time -------------
  {
    const evidence: string[] = [];
    let score = 0;
    for (const c of input.clients) {
      if (c.frameGapP99Ms > 25) {
        score += c.frameGapP99Ms > 50 ? 2 : 1;
        evidence.push(
          `client${c.clientIndex}: frame gap p99 ${c.frameGapP99Ms.toFixed(1)}ms (worst ${c.frameGapMaxMs.toFixed(0)}ms) at ${c.fpsMean.toFixed(0)} fps mean`,
        );
      }
      // Periodic hitches are the classic "stutter" report and stay invisible
      // to a p99, so they score independently of the tail.
      if (c.hitchesPerMin > 2) {
        score += c.hitchesPerMin > 10 ? 2 : 1;
        evidence.push(
          `client${c.clientIndex}: ${c.hitchCount} hitches >4x nominal frame time (${c.hitchesPerMin.toFixed(1)}/min, worst ${c.frameGapMaxMs.toFixed(0)}ms)`,
        );
      }
    }
    const snapshotsHealthy = input.clients.every(
      (c) => c.snapshotGapP95Ms < 2 * c.snapshotCadenceMs,
    );
    if (score > 0 && snapshotsHealthy) {
      score += 1;
      evidence.push('snapshot cadence is healthy, so the stall is in the render loop, not delivery');
    }
    findings.push({ channel: 'RENDER', status: score > 0 ? 'DEGRADED' : 'OK', score, evidence });
  }

  // --- NETWORK: delivery gaps/reordering at the client -----------------------
  {
    const evidence: string[] = [];
    let score = 0;
    for (const c of input.clients) {
      if (c.snapshotGapP95Ms > 2 * c.snapshotCadenceMs) {
        score += c.snapshotGapP95Ms > 4 * c.snapshotCadenceMs ? 2 : 1;
        evidence.push(
          `client${c.clientIndex}: snapshot gap p95 ${c.snapshotGapP95Ms.toFixed(1)}ms vs ${c.snapshotCadenceMs.toFixed(1)}ms cadence (max ${c.snapshotGapMaxMs.toFixed(0)}ms)`,
        );
      }
      if (c.staleDropsPerMin > 2) {
        score += 1;
        evidence.push(
          `client${c.clientIndex}: ${c.staleDropsPerMin.toFixed(1)} stale/out-of-order snapshots per minute`,
        );
      }
      if (c.transport.changes > 0) {
        score += 2;
        evidence.push(
          `client${c.clientIndex}: transport changed mid-run ${c.transport.changes}x — mixed-transport run, treat per-segment`,
        );
      }
    }
    if (score > 0 && input.server && input.server.tickP95MaxMs <= input.server.tickBudgetMs) {
      evidence.push('server tick stayed inside budget, so the gaps arose in transit');
      score += 1;
    }
    if (score > 0 && impaired) {
      evidence.push(
        `NOTE: induced impairment '${input.impairment?.profile}' (${input.impairment?.mode}) explains network degradation by design`,
      );
    }
    findings.push({ channel: 'NETWORK', status: score > 0 ? 'DEGRADED' : 'OK', score, evidence });
  }

  // --- SERVER: simulation over budget or dropping outbound -----------------
  {
    const evidence: string[] = [];
    let score = 0;
    const s = input.server;
    if (s) {
      // Catches the stalls that leave no other server-side trace.
      if (Number.isFinite(s.tickDeficitPct) && s.tickDeficitPct > 2) {
        score += s.tickDeficitPct > 10 ? 3 : 2;
        evidence.push(
          `server ran at ${s.measuredTickHz.toFixed(1)}Hz vs ${s.simHz}Hz nominal — ${s.tickDeficitPct.toFixed(1)}% of ticks never happened (stall/overload, invisible to tick timings)`,
        );
      }
      if (s.statsGapMaxMs > 2500) {
        score += 1;
        evidence.push(
          `server stats feed went quiet for ${s.statsGapMaxMs.toFixed(0)}ms (publishes at 1Hz) — the process was not running`,
        );
      }
      if (s.tickP95MaxMs > s.tickBudgetMs) {
        score += s.tickP95MaxMs > 1.5 * s.tickBudgetMs ? 2 : 1;
        evidence.push(
          `tick p95 peaked at ${s.tickP95MaxMs.toFixed(1)}ms vs ${s.tickBudgetMs.toFixed(1)}ms budget (worst tick ${s.tickMaxMs.toFixed(1)}ms, ${s.tickSpikeAtMs.length} over-budget seconds)`,
        );
      }
      if (s.droppedOutboundSnapshots > 0) {
        score += 2;
        evidence.push(`server dropped ${s.droppedOutboundSnapshots} outbound snapshots (backpressure)`);
      }
      if (s.strictSnapshotDrops > 0) {
        score += 1;
        evidence.push(`${s.strictSnapshotDrops} strict-mode snapshot drops (oversize/closed/unsupported)`);
      }
    } else {
      evidence.push('no server stats captured — server channel unobserved');
    }
    findings.push({ channel: 'SERVER', status: score > 0 ? 'DEGRADED' : 'OK', score, evidence });
  }

  // --- SYNC: corrections/teleports/freezes beyond what the link explains ----
  {
    const evidence: string[] = [];
    let score = 0;
    for (const c of input.clients) {
      if (c.hardSnaps > 0) {
        score += 2;
        evidence.push(`client${c.clientIndex}: ${c.hardSnaps} hard snap(s) — visible teleport(s)`);
      }
      if (c.correctionP95CmP99 > ABSOLUTE_GATES.correctionP95CmP99.warn) {
        score += 2;
        evidence.push(
          `client${c.clientIndex}: sustained corrections p95-tail ${c.correctionP95CmP99.toFixed(1)}cm (max ${c.correctionMaxCm.toFixed(0)}cm)`,
        );
      } else if (c.correctionOnsetsPerMin > ABSOLUTE_GATES.correctionOnsetsPerMin.warn) {
        score += 1;
        evidence.push(
          `client${c.clientIndex}: ${c.correctionOnsetsPerMin.toFixed(1)} visible correction onsets per minute`,
        );
      }
      if (c.freezePct > 1) {
        score += 1;
        evidence.push(
          `client${c.clientIndex}: frozen ${c.freezePct.toFixed(2)}% of moving frames (longest ${c.freezeRunMaxMs.toFixed(0)}ms)`,
        );
      }
      if (c.teleportSteps > 0) {
        score += 1;
        evidence.push(
          `client${c.clientIndex}: ${c.teleportSteps} rendered step(s) >50cm beyond authoritative velocity`,
        );
      }
      if (c.clockJumps > 0) {
        score += 1;
        evidence.push(`client${c.clientIndex}: ${c.clockJumps} clock-offset jump(s) > 1 tick (resync-shaped)`);
      }
      if (c.remote && c.remote.teleportSteps > 0) {
        score += 1;
        evidence.push(
          `client${c.clientIndex} (observer): watched player teleported ${c.remote.teleportSteps}x`,
        );
      }
      // Destructible-city pose anomalies, named by the mechanism that produced
      // them so the reader knows which code path to open.
      const a = c.city?.anomalies;
      if (a) {
        if (a.chunkTeleportsPerMin > 5) {
          score += a.chunkTeleportsPerMin > 30 ? 2 : 1;
          evidence.push(
            `client${c.clientIndex}: ${a.chunkTeleportsPerMin.toFixed(1)} chunk teleports/min (worst ${a.chunkTeleportMaxM.toFixed(2)} m single-frame move)`,
          );
        }
        if (a.snapsPerMin > 10) {
          score += 1;
          const starved = a.snapsDuringStarvationPct;
          evidence.push(
            `client${c.clientIndex}: ${a.snapsPerMin.toFixed(1)} correction snaps/min (worst ${a.snapMaxM.toFixed(2)} m); ${starved.toFixed(0)}% landed while the pose stream was at its byte ceiling — ${starved >= 50 ? 'record starvation, not topology' : 'not primarily starvation'}`,
          );
        }
        if (a.clockRollbacksPerMin > 60) {
          score += 1;
          evidence.push(
            `client${c.clientIndex}: ${a.clockRollbacksPerMin.toFixed(0)} render-clock rollbacks/min (worst ${a.clockRollbackMaxTicks.toFixed(1)} ticks) — presented poses rewound without smoothing`,
          );
        }
        if (a.flickerBodies > 0) {
          score += 1;
          evidence.push(
            `client${c.clientIndex}: ${a.flickerBodies} bodies alternating between the raw and presented pose writers (two poses ~1 interpolation delay apart)`,
          );
        }
        if (a.membershipViolations > 0) {
          score += 2;
          evidence.push(
            `client${c.clientIndex}: ${a.membershipViolations} membership violations — chunkBody[] and chunkSlots disagree (shadow members)`,
          );
        }
        const migrateTotal = a.migrateMissingDestination + a.migrateEmptyDestination;
        if (migrateTotal > 0) {
          score += 2;
          evidence.push(
            `client${c.clientIndex}: ${a.migrateMissingDestination} migrations to a missing island, ${a.migrateEmptyDestination} to an empty one (the empty case rebases the destination's pose and buffer by a garbage delta)`,
          );
        }
        if (a.settleRollbacks > 0) {
          score += 2;
          evidence.push(
            `client${c.clientIndex}: ${a.settleRollbacks} settle rollbacks — a pre-settle pose applied after the body woke`,
          );
        }
        if (a.corruptFrames > 0) {
          score += 2;
          evidence.push(
            `client${c.clientIndex}: ${a.corruptFrames} corrupt island frames (members further apart than the island can span)`,
          );
        }
      }
    }
    const networkDegraded =
      findings.find((f) => f.channel === 'NETWORK')?.status === 'DEGRADED';
    if (score > 0) {
      if (networkDegraded) {
        evidence.push(
          'network is also degraded: read this as sync robustness under transport stress — check tagged events for per-artifact causes',
        );
      } else {
        score += 1;
        evidence.push('link and server look healthy, so these artifacts originate in prediction/reconciliation/clock logic');
      }
    }
    findings.push({ channel: 'SYNC', status: score > 0 ? 'DEGRADED' : 'OK', score, evidence });
  }

  return findings.sort((a, b) => b.score - a.score);
}
