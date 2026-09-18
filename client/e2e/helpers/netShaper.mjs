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
 * @param {'both'|'up'|'down'} [options.direction]  which way to degrade
 * @param {number} [options.reorder]   probability a packet is held an extra
 *                                     delayMs, which lands it behind its
 *                                     successors
 * @param {boolean} [options.preserveOrder]  default true; see below
 */
export async function startShaper(options) {
  const host = options.host ?? '127.0.0.1';
  const target = options.target;
  const delayMs = options.delayMs ?? 0;
  const jitterMs = options.jitterMs ?? 0;
  const loss = options.loss ?? 0;
  const reorder = options.reorder ?? 0;

  // Jitter alone must not shuffle packets. A router queue is FIFO: it can hold
  // a packet longer than the one before it, but it cannot hand it over first.
  // Independent per-packet delay does shuffle them, and badly -- at 40 ms +/-
  // 10 ms a burst sent microseconds apart arrives in a near-random order, which
  // no real single-path link does. QUIC declares a packet lost once three
  // higher-numbered packets are acknowledged, so that shuffle reads as total
  // loss and collapses the congestion window; the link looks broken when only
  // the model is. Delivery is therefore serialised per direction by default,
  // and genuine reordering is a separate, explicit knob.
  const preserveOrder = options.preserveOrder ?? true;

  const stats = {
    toServer: 0, toClient: 0, dropped: 0, reordered: 0,
    bytesToServer: 0, bytesToClient: 0,
    delayMs, jitterMs, loss, reorder, preserveOrder,
  };

  // One socket faces the browser, one faces the server. Two sockets rather than
  // one so the server's replies arrive on a port that is unambiguously ours,
  // and the browser never learns the server's real port.
  const front = dgram.createSocket('udp4');
  const back = dgram.createSocket('udp4');
  let client = null;

  // Last scheduled delivery time per direction, so a serialised packet can be
  // held back behind its predecessor.
  const lastDue = { toServer: 0, toClient: 0 };

  const schedule = (p, counter) => {
    const now = Date.now();
    const spread = p.jitterMs > 0 ? (Math.random() * 2 - 1) * p.jitterMs : 0;
    const jumped = p.reorder > 0 && Math.random() < p.reorder;
    let due = now + Math.max(0, p.delayMs + spread);
    if (jumped) {
      // An overtaken packet: held an extra delay and deliberately not queued
      // behind the ones it now trails. This is the only thing that reorders.
      due += p.delayMs > 0 ? p.delayMs : 20;
      stats.reordered += 1;
    } else if (preserveOrder) {
      due = Math.max(due, lastDue[counter]);
      lastDue[counter] = due;
    }
    return Math.max(0, due - now);
  };

  // Delayed packets are the whole point, so there are always sends in flight
  // when the relay is torn down. Track them and drop them on stop, or node
  // throws ERR_SOCKET_DGRAM_NOT_RUNNING from a timer after the socket closed.
  let closed = false;
  const pending = new Set();

  const relay = (socket, message, port, address, counter, override) => {
    if (closed) return;
    const p = override ?? { delayMs, jitterMs, loss, reorder };
    if (p.loss > 0 && Math.random() < p.loss) {
      stats.dropped += 1;
      return;
    }
    const wait = schedule(p, counter);
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
    stats[counter === 'toServer' ? 'bytesToServer' : 'bytesToClient'] += message.length;
  };

  // Which direction gets degraded. Both by default; 'up' and 'down' exist
  // because "the link is bad" is not a diagnosis -- a stream that dies under
  // jitter might be losing the server's data or losing the client's requests,
  // and those are different bugs in different code.
  const shape = options.direction ?? 'both';
  const clean = { delayMs: 0, jitterMs: 0, loss: 0, reorder: 0 };
  const upstream = shape === 'down' ? clean : null;
  const downstream = shape === 'up' ? clean : null;

  front.on('message', (message, remote) => {
    client = remote;
    relay(back, message, target, host, 'toServer', upstream);
  });
  back.on('message', (message) => {
    if (client) relay(front, message, client.port, client.address, 'toClient', downstream);
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
      + `${reorder ? `, ${(reorder * 100).toFixed(1)}% reorder` : ''}`
      + `${preserveOrder ? '' : ', unordered'}`,
    stop: () => {
      closed = true;
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
      try { front.close(); } catch { /* already closed */ }
      try { back.close(); } catch { /* already closed */ }
    },
  };
}
