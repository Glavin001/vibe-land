import type { LinkProfile } from './scenario';
import { SeededRandom } from './scenario';

export class MockTransport<T> {
  private queue: Array<{ packet: T; deliverAtMs: number }> = [];
  private readonly rng: SeededRandom;

  constructor(
    private config: LinkProfile,
    seed = 42,
  ) {
    this.rng = new SeededRandom(seed);
  }

  send(packet: T, sendTimeMs: number): void {
    if (this.rng.next() < this.config.packetLossRate) {
      return;
    }
    const jitter = (this.rng.next() - 0.5) * 2 * this.config.jitterMs;
    const deliverAt = sendTimeMs + this.config.latencyMs + jitter;
    this.queue.push({ packet, deliverAtMs: Math.max(sendTimeMs, deliverAt) });
  }

  receive(currentTimeMs: number): T[] {
    const ready: Array<{ packet: T; deliverAtMs: number }> = [];
    const remaining: typeof this.queue = [];
    for (const entry of this.queue) {
      if (entry.deliverAtMs <= currentTimeMs) {
        ready.push(entry);
      } else {
        remaining.push(entry);
      }
    }
    this.queue = remaining;
    ready.sort((a, b) => a.deliverAtMs - b.deliverAtMs);
    return ready.map((entry) => entry.packet);
  }
}

export class PacketImpairment<T> {
  private readonly rng: SeededRandom;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private config: LinkProfile,
    seed: number,
    private readonly deliver: (packet: T) => void,
  ) {
    this.rng = new SeededRandom(seed);
  }

  enqueue(packet: T): void {
    if (this.rng.next() < this.config.packetLossRate) {
      return;
    }
    const jitter = (this.rng.next() - 0.5) * 2 * this.config.jitterMs;
    const delayMs = Math.max(0, this.config.latencyMs + jitter);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.deliver(packet);
    }, delayMs);
    this.timers.add(timer);
  }

  dispose(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
