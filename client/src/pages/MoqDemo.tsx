import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { MoqClient, type MoqObject, type MoqSubscription } from '../moq/client';
import {
  DEFAULT_NAMESPACE,
  buildConnectUrl,
  loadMoqDemoConfig,
  parseCertificateHash,
  parseNamespace,
} from '../moq/config';
import {
  CHUNKS_PER_SIDE,
  CHUNK_STATE_LABELS,
  ChunkState,
  REGION_COLUMNS,
  REGION_COUNT,
  applyRegionPayload,
  decodeWorldPayload,
  type MetaPayload,
  type WorldChunk,
} from '../moq/payload';

const BG = '#07111d';
const PANEL = '#0e1a2b';
const PANEL_ALT = '#122239';
const BORDER = '#274463';
const FG = '#e7f0ff';
const MUTED = '#8aa3c2';
const DIM = '#5f7797';
const GREEN = '#63e6be';
const YELLOW = '#ffd166';
const ORANGE = '#ff9f5a';
const RED = '#ff6b6b';
const BLUE = '#6ea8fe';
const CYAN = '#6ef2ff';

/** How often the UI recomputes rates and repaints. */
const REFRESH_MS = 250;
/** Sliding window for the per-track throughput readouts. */
const RATE_WINDOW_MS = 2_000;
/** A cell stays highlighted this long after an update lands. */
const FRESH_MS = 400;

const META_TRACK = 'meta';

type TrackName = string;

interface TrackDefinition {
  name: TrackName;
  label: string;
  /** Region index, or null for the meta track. */
  region: number | null;
  description: string;
}

const TRACKS: TrackDefinition[] = [
  ...Array.from({ length: REGION_COUNT }, (_, region) => ({
    name: `region-${region}`,
    label: `region-${region}`,
    region,
    description:
      region === 0
        ? 'the block underfoot — highest rate, highest priority'
        : `city block ${region} — lower rate the further out it is`,
  })),
  {
    name: META_TRACK,
    label: 'meta',
    region: null,
    description: 'round number, headline, destruction total',
  },
];

interface RateSample {
  atMs: number;
  bytes: number;
}

interface TrackRuntime {
  objects: number;
  bytes: number;
  snapshots: number;
  deltas: number;
  lastGroupId: number | null;
  lastObjectId: number | null;
  lastLatencyMs: number | null;
  lastSeenMs: number | null;
  samples: RateSample[];
}

function emptyRuntime(): TrackRuntime {
  return {
    objects: 0,
    bytes: 0,
    snapshots: 0,
    deltas: 0,
    lastGroupId: null,
    lastObjectId: null,
    lastLatencyMs: null,
    lastSeenMs: null,
    samples: [],
  };
}

interface RegionView {
  chunks: Map<number, WorldChunk>;
  touchedAt: Map<number, number>;
}

type Status = 'idle' | 'connecting' | 'connected' | 'error';

interface LogEntry {
  atMs: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export function MoqDemoPage() {
  const initial = useMemo(() => loadMoqDemoConfig(window.location.search), []);

  const [endpoint, setEndpoint] = useState(initial.endpoint);
  const [token, setToken] = useState(initial.token);
  const [namespaceText, setNamespaceText] = useState(initial.namespace.join('/'));
  const [certificateHash, setCertificateHash] = useState(initial.certificateHash ?? '');

  const [status, setStatus] = useState<Status>('idle');
  const [statusDetail, setStatusDetail] = useState('');
  const [wanted, setWanted] = useState<Set<TrackName>>(
    () => new Set(TRACKS.map((track) => track.name)),
  );
  const [log, setLog] = useState<LogEntry[]>([]);
  // Bumped on a timer so the readouts refresh without re-rendering per object.
  const [, setRefreshTick] = useState(0);

  const clientRef = useRef<MoqClient | null>(null);
  const subscriptionsRef = useRef(new Map<TrackName, MoqSubscription>());
  /** Tracks with a SUBSCRIBE or UNSUBSCRIBE in flight, to keep toggles serial. */
  const inFlightRef = useRef(new Set<TrackName>());
  const runtimeRef = useRef(new Map<TrackName, TrackRuntime>());
  const regionsRef = useRef(new Map<number, RegionView>());
  const metaRef = useRef<MetaPayload | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const appendLog = useCallback((level: LogEntry['level'], message: string) => {
    setLog((entries) => [{ atMs: Date.now(), level, message }, ...entries].slice(0, 60));
  }, []);

  const runtimeFor = useCallback((name: TrackName): TrackRuntime => {
    let runtime = runtimeRef.current.get(name);
    if (!runtime) {
      runtime = emptyRuntime();
      runtimeRef.current.set(name, runtime);
    }
    return runtime;
  }, []);

  const handleObject = useCallback(
    (track: TrackDefinition, object: MoqObject) => {
      // Zero-length objects are end-of-group / end-of-track markers.
      if (object.payload.length === 0) return;

      const runtime = runtimeFor(track.name);
      const now = Date.now();

      runtime.objects += 1;
      runtime.bytes += object.payload.length;
      runtime.lastGroupId = object.groupId;
      runtime.lastObjectId = object.objectId;
      runtime.lastSeenMs = now;
      runtime.samples.push({ atMs: now, bytes: object.payload.length });

      try {
        const payload = decodeWorldPayload(object.payload);
        runtime.lastLatencyMs = now - payload.publishedAtMs;

        if (payload.kind === 'meta') {
          metaRef.current = payload;
          return;
        }

        if (payload.kind === 'snapshot') runtime.snapshots += 1;
        else runtime.deltas += 1;

        const view = regionsRef.current.get(payload.region) ?? {
          chunks: new Map<number, WorldChunk>(),
          touchedAt: new Map<number, number>(),
        };

        const touchedAt = payload.kind === 'snapshot' ? new Map<number, number>() : view.touchedAt;
        for (const chunk of payload.chunks) touchedAt.set(chunk.id, now);

        regionsRef.current.set(payload.region, {
          chunks: applyRegionPayload(view.chunks, payload),
          touchedAt,
        });
      } catch (error) {
        appendLog('warn', `bad payload on ${track.name}: ${describeError(error)}`);
      }
    },
    [appendLog, runtimeFor],
  );

  const disconnect = useCallback(async () => {
    const client = clientRef.current;
    clientRef.current = null;
    subscriptionsRef.current.clear();
    if (client) await client.close('disconnected from the demo page');
    setStatus('idle');
    setStatusDetail('');
  }, []);

  const connect = useCallback(async () => {
    if (clientRef.current) return;

    setStatus('connecting');
    setStatusDetail('');
    runtimeRef.current.clear();
    regionsRef.current.clear();
    metaRef.current = null;

    const url = buildConnectUrl(endpoint, token);
    const namespace = parseNamespace(namespaceText);

    try {
      const client = await MoqClient.connect(url, {
        serverCertificateHashes: certificateHash.trim()
          ? parseCertificateHash(certificateHash)
          : undefined,
        onLog: (level, message) => appendLog(level, message),
        onClose: (reason) => {
          clientRef.current = null;
          subscriptionsRef.current.clear();
          setStatus('idle');
          appendLog('warn', `session closed: ${reason}`);
        },
      });

      clientRef.current = client;
      setStatus('connected');
      appendLog('info', `connected to ${redact(url)}`);

      for (const track of TRACKS) {
        if (!wanted.has(track.name)) continue;
        await subscribeTrack(client, track);
      }
    } catch (error) {
      clientRef.current = null;
      setStatus('error');
      setStatusDetail(describeError(error));
      appendLog('error', `connect failed: ${describeError(error)}`);
    }

    async function subscribeTrack(client: MoqClient, track: TrackDefinition) {
      try {
        const subscription = await client.subscribe(namespace, track.name, (object) =>
          handleObject(track, object),
        );
        subscriptionsRef.current.set(track.name, subscription);
      } catch (error) {
        appendLog('error', `subscribe ${track.name} failed: ${describeError(error)}`);
      }
    }
  }, [appendLog, certificateHash, endpoint, handleObject, namespaceText, token, wanted]);

  /** Reconcile live subscriptions with the checkboxes while connected. */
  useEffect(() => {
    const client = clientRef.current;
    if (!client || status !== 'connected') return;

    const namespace = parseNamespace(namespaceText);

    void (async () => {
      for (const track of TRACKS) {
        // A SUBSCRIBE takes a round trip to confirm. Without this guard, two
        // quick clicks would start two subscriptions for the same track and
        // leak the first one.
        if (inFlightRef.current.has(track.name)) continue;

        const existing = subscriptionsRef.current.get(track.name);
        const shouldHave = wanted.has(track.name);
        if (shouldHave === Boolean(existing)) continue;

        inFlightRef.current.add(track.name);
        try {
          if (shouldHave) {
            const subscription = await client.subscribe(namespace, track.name, (object) =>
              handleObject(track, object),
            );
            subscriptionsRef.current.set(track.name, subscription);
          } else if (existing) {
            subscriptionsRef.current.delete(track.name);
            await existing.unsubscribe();
          }
        } catch (error) {
          appendLog('error', `${track.name}: ${describeError(error)}`);
        } finally {
          inFlightRef.current.delete(track.name);
        }
      }
    })();
  }, [appendLog, handleObject, namespaceText, status, wanted]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const cutoff = Date.now() - RATE_WINDOW_MS;
      for (const runtime of runtimeRef.current.values()) {
        while (runtime.samples.length > 0 && runtime.samples[0].atMs < cutoff) {
          runtime.samples.shift();
        }
      }
      setRefreshTick((tick) => tick + 1);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => void clientRef.current?.close('page unmounted'), []);

  const rates = (() => {
    const now = Date.now();
    const result = new Map<TrackName, { objectsPerSecond: number; bytesPerSecond: number }>();

    for (const track of TRACKS) {
      const runtime = runtimeRef.current.get(track.name);
      if (!runtime || runtime.samples.length === 0) {
        result.set(track.name, { objectsPerSecond: 0, bytesPerSecond: 0 });
        continue;
      }
      const windowSeconds = Math.max(
        (now - Math.min(runtime.samples[0].atMs, now - REFRESH_MS)) / 1000,
        REFRESH_MS / 1000,
      );
      const bytes = runtime.samples.reduce((total, sample) => total + sample.bytes, 0);
      result.set(track.name, {
        objectsPerSecond: runtime.samples.length / windowSeconds,
        bytesPerSecond: bytes / windowSeconds,
      });
    }
    return result;
    // Recomputed on every render; the mutable runtime refs are the real input,
    // and the refresh timer is what schedules the renders.
  })();

  const totalBytesPerSecond = TRACKS.reduce(
    (total, track) => total + (rates.get(track.name)?.bytesPerSecond ?? 0),
    0,
  );

  useEffect(() => {
    drawRegions(canvasRef.current, regionsRef.current, wanted);
  });

  // A read-only handle for the Playwright end-to-end test.
  useEffect(() => {
    (window as unknown as { __MOQ_DEMO__?: unknown }).__MOQ_DEMO__ = {
      status,
      tracks: Object.fromEntries(
        TRACKS.map((track) => {
          const runtime = runtimeRef.current.get(track.name) ?? emptyRuntime();
          return [
            track.name,
            {
              subscribed: subscriptionsRef.current.has(track.name),
              objects: runtime.objects,
              bytes: runtime.bytes,
              snapshots: runtime.snapshots,
              deltas: runtime.deltas,
              lastGroupId: runtime.lastGroupId,
            },
          ];
        }),
      ),
      regions: Object.fromEntries(
        Array.from(regionsRef.current.entries(), ([region, view]) => [region, view.chunks.size]),
      ),
      meta: metaRef.current,
    };
  });

  const connected = status === 'connected';
  const meta = metaRef.current;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: BG,
        color: FG,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        padding: '24px',
      }}
    >
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <header style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, margin: 0, letterSpacing: 0.5 }}>
            MoQ world-state transport
          </h1>
          <p style={{ color: MUTED, margin: '8px 0 0', lineHeight: 1.6, maxWidth: 760 }}>
            The publisher splits a destruction sim into one MoQ track per region and runs each at
            its own rate. Subscribe to a track and its quadrant animates; unsubscribe and it
            freezes while the relay stops sending you those bytes. Nothing here is media — the
            objects carry a packed struct of chunk positions and states.
          </p>
        </header>

        <section style={panelStyle}>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
            <Field label="Relay endpoint">
              <input
                style={inputStyle}
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                disabled={connected || status === 'connecting'}
                spellCheck={false}
              />
            </Field>
            <Field label="Subscribe token (path segment)">
              <input
                style={inputStyle}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                disabled={connected || status === 'connecting'}
                placeholder="subscribe-only token"
                spellCheck={false}
                type="password"
              />
            </Field>
            <Field label="Namespace">
              <input
                style={inputStyle}
                value={namespaceText}
                onChange={(event) => setNamespaceText(event.target.value)}
                disabled={connected || status === 'connecting'}
                placeholder={DEFAULT_NAMESPACE}
                spellCheck={false}
              />
            </Field>
            <Field label="Certificate hash (local relay only)">
              <input
                style={inputStyle}
                value={certificateHash}
                onChange={(event) => setCertificateHash(event.target.value)}
                disabled={connected || status === 'connecting'}
                placeholder="sha-256 hex, blank for a public relay"
                spellCheck={false}
              />
            </Field>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
            <button
              type="button"
              data-testid="moq-connect"
              onClick={() => void (connected ? disconnect() : connect())}
              disabled={status === 'connecting'}
              style={{
                ...buttonStyle,
                background: connected ? 'rgba(255,107,107,0.14)' : 'rgba(110,242,255,0.14)',
                borderColor: connected ? RED : CYAN,
                color: connected ? RED : CYAN,
              }}
            >
              {connected ? 'Disconnect' : status === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>

            <span data-testid="moq-status" style={{ color: statusColor(status) }}>
              {status}
              {statusDetail ? ` — ${statusDetail}` : ''}
            </span>

            <span style={{ marginLeft: 'auto', color: MUTED }}>
              total{' '}
              <strong style={{ color: FG }}>{(totalBytesPerSecond / 1000).toFixed(1)} kB/s</strong>{' '}
              across subscribed tracks
            </span>
          </div>
        </section>

        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: '520px 1fr', marginTop: 16 }}>
          <section style={panelStyle}>
            <h2 style={headingStyle}>World</h2>
            <canvas
              ref={canvasRef}
              width={480}
              height={480}
              style={{ width: '100%', maxWidth: 480, display: 'block', borderRadius: 6 }}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
              {Object.entries(CHUNK_STATE_LABELS).map(([state, label]) => (
                <span key={state} style={{ color: MUTED, fontSize: 12 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 10,
                      height: 10,
                      marginRight: 6,
                      borderRadius: 2,
                      background: stateColor(Number(state)),
                    }}
                  />
                  {label}
                </span>
              ))}
            </div>

            {meta ? (
              <div
                style={{
                  marginTop: 14,
                  padding: 12,
                  background: PANEL_ALT,
                  borderRadius: 6,
                  border: `1px solid ${BORDER}`,
                }}
              >
                <div style={{ color: MUTED, fontSize: 12, marginBottom: 6 }}>meta track</div>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                  <Stat label="round" value={String(meta.round)} />
                  <Stat label="alive" value={String(meta.playersAlive)} />
                  <Stat label="destroyed" value={`${meta.destroyedPct}%`} />
                </div>
                <div style={{ marginTop: 8, color: YELLOW }}>{meta.headline}</div>
              </div>
            ) : null}
          </section>

          <section style={panelStyle}>
            <h2 style={headingStyle}>Tracks</h2>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: DIM, textAlign: 'left' }}>
                  <th style={cellStyle}>sub</th>
                  <th style={cellStyle}>track</th>
                  <th style={{ ...cellStyle, textAlign: 'right' }}>obj/s</th>
                  <th style={{ ...cellStyle, textAlign: 'right' }}>kB/s</th>
                  <th style={{ ...cellStyle, textAlign: 'right' }}>group</th>
                  <th style={{ ...cellStyle, textAlign: 'right' }}>keyframes</th>
                  <th style={{ ...cellStyle, textAlign: 'right' }}>lag</th>
                </tr>
              </thead>
              <tbody>
                {TRACKS.map((track) => {
                  const runtime = runtimeRef.current.get(track.name) ?? emptyRuntime();
                  const rate = rates.get(track.name);
                  const subscribed = wanted.has(track.name);

                  return (
                    <tr key={track.name} style={{ borderTop: `1px solid ${BORDER}` }}>
                      <td style={cellStyle}>
                        <input
                          type="checkbox"
                          data-testid={`moq-toggle-${track.name}`}
                          checked={subscribed}
                          onChange={(event) => {
                            setWanted((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(track.name);
                              else next.delete(track.name);
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td style={cellStyle}>
                        <div style={{ color: subscribed ? FG : DIM }}>{track.label}</div>
                        <div style={{ color: DIM, fontSize: 11 }}>{track.description}</div>
                      </td>
                      <td style={numberCellStyle}>{(rate?.objectsPerSecond ?? 0).toFixed(1)}</td>
                      <td style={numberCellStyle}>
                        {((rate?.bytesPerSecond ?? 0) / 1000).toFixed(2)}
                      </td>
                      <td style={numberCellStyle}>
                        {runtime.lastGroupId === null
                          ? '—'
                          : `${runtime.lastGroupId}.${runtime.lastObjectId}`}
                      </td>
                      <td style={numberCellStyle}>{runtime.snapshots}</td>
                      <td style={numberCellStyle}>
                        {runtime.lastLatencyMs === null ? '—' : `${runtime.lastLatencyMs} ms`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <p style={{ color: DIM, fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
              <strong style={{ color: MUTED }}>lag</strong> is the publisher's wall clock subtracted
              from the browser's, so it only means something when the two machines have synced
              clocks. Treat it as a trend, not a measurement.{' '}
              <strong style={{ color: MUTED }}>group</strong> is the current group and object index
              — each new group opens with a keyframe.
            </p>

            <h2 style={{ ...headingStyle, marginTop: 20 }}>Log</h2>
            <div
              data-testid="moq-log"
              style={{
                maxHeight: 220,
                overflowY: 'auto',
                background: PANEL_ALT,
                border: `1px solid ${BORDER}`,
                borderRadius: 6,
                padding: 10,
                fontSize: 12,
              }}
            >
              {log.length === 0 ? (
                <div style={{ color: DIM }}>nothing yet</div>
              ) : (
                log.map((entry) => (
                  <div key={`${entry.atMs}-${entry.message}`} style={{ marginBottom: 4 }}>
                    <span style={{ color: DIM }}>
                      {new Date(entry.atMs).toLocaleTimeString()}{' '}
                    </span>
                    <span style={{ color: logColor(entry.level) }}>{entry.message}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ color: MUTED, fontSize: 12, marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: DIM, fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 18 }}>{value}</div>
    </div>
  );
}

function stateColor(state: number): string {
  switch (state) {
    case ChunkState.Intact:
      return BLUE;
    case ChunkState.Damaged:
      return YELLOW;
    case ChunkState.Falling:
      return ORANGE;
    case ChunkState.Rubble:
      return '#3d4c60';
    default:
      return DIM;
  }
}

function statusColor(status: Status): string {
  if (status === 'connected') return GREEN;
  if (status === 'error') return RED;
  if (status === 'connecting') return YELLOW;
  return MUTED;
}

function logColor(level: LogEntry['level']): string {
  if (level === 'error') return RED;
  if (level === 'warn') return YELLOW;
  return MUTED;
}

/**
 * Paint the 2x2 grid of regions. Each region is an 8x8 block of chunks, drawn
 * from whatever that region's track last delivered — so an unsubscribed region
 * simply stops changing.
 */
function drawRegions(
  canvas: HTMLCanvasElement | null,
  regions: Map<number, RegionView>,
  subscribed: Set<TrackName>,
): void {
  const context = canvas?.getContext('2d');
  if (!canvas || !context) return;

  const now = Date.now();
  const regionSize = canvas.width / REGION_COLUMNS;
  const cellSize = regionSize / CHUNKS_PER_SIDE;

  context.fillStyle = '#050c15';
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let region = 0; region < REGION_COUNT; region += 1) {
    const originX = (region % REGION_COLUMNS) * regionSize;
    const originY = Math.floor(region / REGION_COLUMNS) * regionSize;
    const view = regions.get(region);
    const isSubscribed = subscribed.has(`region-${region}`);

    context.globalAlpha = isSubscribed ? 1 : 0.35;

    for (let id = 0; id < CHUNKS_PER_SIDE * CHUNKS_PER_SIDE; id += 1) {
      const cellX = originX + (id % CHUNKS_PER_SIDE) * cellSize;
      const cellY = originY + Math.floor(id / CHUNKS_PER_SIDE) * cellSize;
      const chunk = view?.chunks.get(id);

      if (!chunk) {
        context.fillStyle = '#0b1624';
        context.fillRect(cellX + 1, cellY + 1, cellSize - 2, cellSize - 2);
        continue;
      }

      context.fillStyle = stateColor(chunk.state);
      context.fillRect(cellX + 1, cellY + 1, cellSize - 2, cellSize - 2);

      // Undamaged chunks read as solid; damage eats into the block.
      if (chunk.state === ChunkState.Damaged) {
        const healthy = Math.max(0, Math.min(1, chunk.hp / 255));
        context.fillStyle = 'rgba(5, 12, 21, 0.55)';
        context.fillRect(
          cellX + 1,
          cellY + 1,
          cellSize - 2,
          (cellSize - 2) * (1 - healthy),
        );
      }

      const touchedAt = view?.touchedAt.get(id) ?? 0;
      if (now - touchedAt < FRESH_MS) {
        context.strokeStyle = CYAN;
        context.lineWidth = 1.5;
        context.strokeRect(cellX + 1.5, cellY + 1.5, cellSize - 3, cellSize - 3);
      }
    }

    context.globalAlpha = 1;
    context.strokeStyle = isSubscribed ? BORDER : '#1a2b3f';
    context.lineWidth = 1;
    context.strokeRect(originX + 0.5, originY + 0.5, regionSize - 1, regionSize - 1);

    context.fillStyle = isSubscribed ? MUTED : DIM;
    context.font = '11px ui-monospace, monospace';
    context.fillText(
      isSubscribed ? `region-${region}` : `region-${region} (unsubscribed)`,
      originX + 8,
      originY + 16,
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keep the token out of the on-screen log. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.length > 1) parsed.pathname = '/<token>';
    return parsed.toString();
  } catch {
    return url;
  }
}

const panelStyle: CSSProperties = {
  background: PANEL,
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  padding: 16,
};

const headingStyle: CSSProperties = {
  fontSize: 14,
  margin: '0 0 12px',
  color: MUTED,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
};

const inputStyle: CSSProperties = {
  width: '100%',
  background: '#08131f',
  border: `1px solid ${BORDER}`,
  borderRadius: 4,
  color: FG,
  padding: '7px 9px',
  fontFamily: 'inherit',
  fontSize: 13,
};

const buttonStyle: CSSProperties = {
  border: `1px solid ${BORDER}`,
  borderRadius: 4,
  padding: '8px 18px',
  fontFamily: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
};

const cellStyle: CSSProperties = {
  padding: '8px 6px',
  verticalAlign: 'top',
};

const numberCellStyle: CSSProperties = {
  ...cellStyle,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};
