/**
 * Tap the server's live 1 Hz stats feed (WS /ws/stats) into server-stats.jsonl.
 *
 * Server-side evidence is what lets the analyzer tell a network stall from a
 * server stall: tick timings and outbound-drop counters live only here.
 */

import fs from 'node:fs';
import WebSocket from 'ws';

export interface ServerStatsTap {
  /** Messages written so far. */
  count(): number;
  close(): Promise<void>;
}

export function startServerStatsTap(serverHttpUrl: string, outPath: string): ServerStatsTap {
  const wsUrl = serverHttpUrl.replace(/^http/, 'ws') + '/ws/stats';
  const out = fs.createWriteStream(outPath, { flags: 'w' });
  let written = 0;
  let closed = false;
  let socket: WebSocket | null = null;

  const connect = (): void => {
    if (closed) return;
    socket = new WebSocket(wsUrl, { rejectUnauthorized: false });
    socket.on('message', (data) => {
      written += 1;
      out.write(
        JSON.stringify({ receivedAtMs: Date.now(), stats: JSON.parse(data.toString()) }) + '\n',
      );
    });
    socket.on('error', (err) => {
      console.warn('[netlab] stats websocket error:', err.message);
    });
    socket.on('close', () => {
      if (!closed) setTimeout(connect, 2000);
    });
  };
  connect();

  return {
    count: () => written,
    close: () =>
      new Promise((resolve) => {
        closed = true;
        socket?.close();
        out.end(resolve);
      }),
  };
}
