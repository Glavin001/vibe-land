/**
 * A UDP relay that degrades the link on purpose.
 *
 * WebTransport is QUIC over UDP, and the channel the city streams on is
 * unreliable by design: it expects loss, reordering and jitter. Loopback gives
 * none of those, so every QA run so far has tested the netcode on a perfect
 * link and proved nothing about what a player over the internet sees.
 *
 * `tc netem` would be the obvious tool and is unavailable here -- the container
 * has no NET_ADMIN, so every qdisc call returns EPERM. A userspace relay needs
 * no privileges and is better targeted: it shapes only the game's traffic and
 * leaves the API, the page load and this process's own I/O alone.
 *
 * QUIC survives the indirection because the relay keeps a stable 4-tuple per
 * direction; the server simply sees the relay as the client.
 *
 *   const shaper = await startShaper({ target: 4433, delayMs: 40, jitterMs: 12, loss: 0.02 });
 *   // point the client's WebTransport URL at shaper.port
 *   shaper.stop();
 */
import dgram from 'node:dgram';

/**
 * @param {object} options
 * @param {number} options.target      server UDP port to relay to
 * @param {number} [options.listen]    port to listen on, 0 picks a free one
 * @param {string} [options.host]      target host, default 127.0.0.1
 * @param {number} [options.delayMs]   one-way delay added to every packet
 * @param {number} [options.jitterMs]  uniform +/- jitter around that delay
 * @param {number} [options.loss]      drop probability per packet, 0..1
 * @param {number} [options.reorder]   probability a packet is held an extra
 *                                     delayMs, which lands it behind its
 *                                     successors
 */
export async function startShaper(options) {
  const host = options.host ?? '127.0.0.1';
  const target = options.target;
  const delayMs = options.delayMs ?? 0;
  const jitterMs = options.jitterMs ?? 0;
  const loss = options.loss ?? 0;
  const reorder = options.reorder ?? 0;

  const stats = {
    toServer: 0, toClient: 0, dropped: 0, reordered: 0,
    delayMs, jitterMs, loss, reorder,
  };

  // One socket faces the browser, one faces the server. Two sockets rather than
  // one so the server's replies arrive on a port that is unambiguously ours,
  // and the browser never learns the server's real port.
  const front = dgram.createSocket('udp4');
  const back = dgram.createSocket('udp4');
  let client = null;

  const jittered = () => {
    const spread = jitterMs > 0 ? (Math.random() * 2 - 1) * jitterMs : 0;
    const extra = reorder > 0 && Math.random() < reorder ? delayMs : 0;
    if (extra) stats.reordered += 1;
    return Math.max(0, delayMs + spread + extra);
  };

  // Delayed packets are the whole point, so there are always sends in flight
  // when the relay is torn down. Track them and drop them on stop, or node
  // throws ERR_SOCKET_DGRAM_NOT_RUNNING from a timer after the socket closed.
  let closed = false;
  const pending = new Set();

  const relay = (socket, message, port, address, counter) => {
    if (closed) return;
    if (loss > 0 && Math.random() < loss) {
      stats.dropped += 1;
      return;
    }
    const wait = jittered();
    const send = () => {
      if (closed) return;
      try { socket.send(message, port, address, () => {}); } catch { /* closing */ }
    };
    if (wait <= 0) {
      send();
    } else {
      const timer = setTimeout(() => { pending.delete(timer); send(); }, wait);
      pending.add(timer);
    }
    stats[counter] += 1;
  };

  front.on('message', (message, remote) => {
    client = remote;
    relay(back, message, target, host, 'toServer');
  });
  back.on('message', (message) => {
    if (client) relay(front, message, client.port, client.address, 'toClient');
  });

  await new Promise((resolve, reject) => {
    front.once('error', reject);
    front.bind(options.listen ?? 0, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => {
    back.once('error', reject);
    back.bind(0, '127.0.0.1', resolve);
  });

  const port = front.address().port;
  return {
    port,
    stats,
    describe: () =>
      `link: +${delayMs}ms${jitterMs ? ` ±${jitterMs}ms` : ''}`
      + `${loss ? `, ${(loss * 100).toFixed(1)}% loss` : ''}`
      + `${reorder ? `, ${(reorder * 100).toFixed(1)}% reorder` : ''}`,
    stop: () => {
      closed = true;
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
      try { front.close(); } catch { /* already closed */ }
      try { back.close(); } catch { /* already closed */ }
    },
  };
}
