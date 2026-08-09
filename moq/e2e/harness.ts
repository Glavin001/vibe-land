/**
 * Headless harness for the end-to-end check in `verify-local.mjs`.
 *
 * It drives the same `client/src/moq` modules the demo page uses, minus React,
 * and publishes its observations on `window.__MOQ_E2E__` for Playwright to
 * assert against. The point is to exercise the real MoQ client against a real
 * relay — the demo page is thin glue on top of exactly these calls.
 */

import { MoqClient, type MoqSubscription } from '../../client/src/moq/client';
import { buildConnectUrl, parseCertificateHash, parseNamespace } from '../../client/src/moq/config';
import { decodeWorldPayload, type MetaPayload } from '../../client/src/moq/payload';

interface TrackReport {
  objects: number;
  bytes: number;
  snapshots: number;
  deltas: number;
  groups: number[];
  chunkIds: number[];
  subscribed: boolean;
  error: string | null;
}

interface HarnessState {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error: string | null;
  logs: string[];
  tracks: Record<string, TrackReport>;
  meta: MetaPayload | null;
}

const state: HarnessState = {
  status: 'idle',
  error: null,
  logs: [],
  tracks: {},
  meta: null,
};

const subscriptions = new Map<string, MoqSubscription>();

function reportFor(track: string): TrackReport {
  let report = state.tracks[track];
  if (!report) {
    report = {
      objects: 0,
      bytes: 0,
      snapshots: 0,
      deltas: 0,
      groups: [],
      chunkIds: [],
      subscribed: false,
      error: null,
    };
    state.tracks[track] = report;
  }
  return report;
}

async function run(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const endpoint = params.get('relay') ?? '';
  const token = params.get('token') ?? '';
  const namespace = parseNamespace(params.get('ns') ?? 'vibe-land/demo');
  const certificateHash = params.get('certhash');
  const tracks = (params.get('tracks') ?? 'region-0,region-1,region-2,region-3,meta').split(',');

  state.status = 'connecting';

  const client = await MoqClient.connect(buildConnectUrl(endpoint, token), {
    serverCertificateHashes: certificateHash ? parseCertificateHash(certificateHash) : undefined,
    onLog: (level, message) => state.logs.push(`${level}: ${message}`),
    onClose: (reason) => state.logs.push(`closed: ${reason}`),
  });

  state.status = 'connected';

  for (const track of tracks) {
    const report = reportFor(track);
    try {
      const subscription = await client.subscribe(namespace, track, (object) => {
        if (object.payload.length === 0) return;

        report.objects += 1;
        report.bytes += object.payload.length;
        if (!report.groups.includes(object.groupId)) report.groups.push(object.groupId);

        try {
          const payload = decodeWorldPayload(object.payload);
          if (payload.kind === 'meta') {
            state.meta = payload;
            return;
          }
          if (payload.kind === 'snapshot') report.snapshots += 1;
          else report.deltas += 1;

          for (const chunk of payload.chunks) {
            if (!report.chunkIds.includes(chunk.id)) report.chunkIds.push(chunk.id);
          }
        } catch (error) {
          report.error = error instanceof Error ? error.message : String(error);
        }
      });

      subscriptions.set(track, subscription);
      report.subscribed = true;
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
  }
}

// Playwright calls this to prove that unsubscribing actually stops the flow.
(window as unknown as Record<string, unknown>).__MOQ_E2E_UNSUBSCRIBE__ = async (track: string) => {
  const subscription = subscriptions.get(track);
  if (!subscription) return false;
  subscriptions.delete(track);
  await subscription.unsubscribe();
  reportFor(track).subscribed = false;
  return true;
};

(window as unknown as Record<string, unknown>).__MOQ_E2E__ = state;

void run().catch((error: unknown) => {
  state.status = 'error';
  state.error = error instanceof Error ? error.message : String(error);
});
