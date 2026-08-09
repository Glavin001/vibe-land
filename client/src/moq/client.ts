/**
 * A minimal MoQ Transport draft-16 subscriber for the browser.
 *
 * Deliberately not a media player: it hands you the raw object payloads and
 * their group/object coordinates, which is all you need when the "media" is
 * your own game state. No WebCodecs, no catalog, no dependencies.
 *
 * Scope is subscribe-only. Publishing from the browser needs the PUBLISH and
 * PUBLISH_NAMESPACE flows, which the Rust publisher in `moq/publisher` covers.
 */

import { StreamReader } from './coding';
import {
  ControlMessageType,
  decodeRequestError,
  decodeSubscribeOk,
  describeRequestError,
  encodeClientSetup,
  encodeSubscribe,
  encodeUnsubscribe,
  readControlMessage,
  readSubgroupHeader,
  readSubgroupObject,
  subgroupStreamShape,
  ObjectStatus,
} from './protocol';

/** One object delivered on a track. */
export interface MoqObject {
  groupId: number;
  subgroupId: number;
  objectId: number;
  publisherPriority: number;
  /** Non-zero for the end-of-group and end-of-track markers. */
  status: number;
  payload: Uint8Array;
  /** `performance.timeOrigin`-based receive time, for latency measurement. */
  receivedAt: number;
}

export type MoqObjectHandler = (object: MoqObject) => void;

export interface MoqSubscription {
  readonly namespace: readonly string[];
  readonly track: string;
  /** Relay-assigned alias that identifies this track on data streams. */
  readonly trackAlias: number;
  readonly objectCount: number;
  readonly byteCount: number;
  readonly active: boolean;
  unsubscribe(): Promise<void>;
}

export interface MoqClientOptions {
  /**
   * Ceiling on request IDs we let the relay use toward us. We never serve
   * requests, but the relay still expects a number.
   */
  maxRequestId?: number;
  /**
   * Pin a self-signed certificate by hash, for a relay on localhost. Chrome
   * only accepts this for certificates valid 14 days or less.
   */
  serverCertificateHashes?: WebTransportHash[];
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Called when the session ends, cleanly or otherwise. */
  onClose?: (reason: string) => void;
}

const DEFAULT_MAX_REQUEST_ID = 100;

/**
 * How long a data stream waits for its track alias to be assigned. Data can
 * legitimately arrive before we have finished processing the SUBSCRIBE_OK that
 * names the alias, so a brief wait avoids dropping the first group.
 */
const ALIAS_RESOLUTION_TIMEOUT_MS = 5_000;

interface PendingRequest {
  resolve: (value: { trackAlias: number }) => void;
  reject: (reason: Error) => void;
}

class Subscription implements MoqSubscription {
  objectCount = 0;
  byteCount = 0;
  active = true;

  constructor(
    readonly requestId: number,
    readonly namespace: readonly string[],
    readonly track: string,
    readonly trackAlias: number,
    readonly handler: MoqObjectHandler,
    private readonly onUnsubscribe: (subscription: Subscription) => Promise<void>,
  ) {}

  async unsubscribe(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await this.onUnsubscribe(this);
  }
}

export class MoqClient {
  #transport: WebTransport;
  #controlWriter: WritableStreamDefaultWriter<Uint8Array>;
  #controlReader: StreamReader;
  #options: MoqClientOptions;

  #nextRequestId = 0;
  #pending = new Map<number, PendingRequest>();
  #byRequestId = new Map<number, Subscription>();
  #byAlias = new Map<number, Subscription>();
  /** Data streams parked until their track alias is known. */
  #aliasWaiters = new Map<number, Array<(subscription: Subscription) => void>>();
  #closed = false;

  private constructor(
    transport: WebTransport,
    controlWriter: WritableStreamDefaultWriter<Uint8Array>,
    controlReader: StreamReader,
    options: MoqClientOptions,
  ) {
    this.#transport = transport;
    this.#controlWriter = controlWriter;
    this.#controlReader = controlReader;
    this.#options = options;
  }

  /**
   * Open a WebTransport session and complete the MoQ setup handshake.
   *
   * For Cloudflare, `url` is the draft-16 endpoint with a subscribe-capable
   * token in the path:
   * `https://draft-16.cloudflare.mediaoverquic.com/<subscribe-token>`.
   */
  static async connect(url: string, options: MoqClientOptions = {}): Promise<MoqClient> {
    if (typeof WebTransport === 'undefined') {
      throw new Error('WebTransport is not available in this browser');
    }

    const transport = new WebTransport(
      url,
      options.serverCertificateHashes
        ? { serverCertificateHashes: options.serverCertificateHashes }
        : undefined,
    );
    await transport.ready;

    // The control stream must be the first bidirectional stream on the session.
    const control = await transport.createBidirectionalStream();
    const controlWriter = control.writable.getWriter();
    const controlReader = new StreamReader(control.readable);

    const maxRequestId = options.maxRequestId ?? DEFAULT_MAX_REQUEST_ID;
    await controlWriter.write(encodeClientSetup(maxRequestId));

    const setup = await readControlMessage(controlReader);
    if (setup.type !== ControlMessageType.ServerSetup) {
      throw new Error(
        `expected SERVER_SETUP (0x21), got 0x${setup.type.toString(16)} — is this a draft-16 relay?`,
      );
    }

    const client = new MoqClient(transport, controlWriter, controlReader, options);
    client.#log('info', 'MoQ session established');

    void client.#runControlLoop();
    void client.#runDataLoop();
    void client.#watchForClose();

    return client;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Subscribe to one track. Resolves once the relay confirms with
   * SUBSCRIBE_OK, and rejects with the relay's reason if it refuses.
   */
  async subscribe(
    namespace: readonly string[],
    track: string,
    handler: MoqObjectHandler,
  ): Promise<MoqSubscription> {
    if (this.#closed) throw new Error('session is closed');

    // Client-initiated requests use even IDs; the relay uses odd ones.
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 2;

    const confirmed = new Promise<{ trackAlias: number }>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
    });

    await this.#controlWriter.write(encodeSubscribe(requestId, namespace, track));

    const { trackAlias } = await confirmed;

    const subscription = new Subscription(
      requestId,
      namespace,
      track,
      trackAlias,
      handler,
      (target) => this.#unsubscribe(target),
    );

    this.#byRequestId.set(requestId, subscription);
    this.#byAlias.set(trackAlias, subscription);
    this.#resolveAliasWaiters(trackAlias, subscription);

    this.#log('info', `subscribed to ${namespace.join('/')}/${track} (alias ${trackAlias})`);
    return subscription;
  }

  async close(reason = 'client closed'): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    for (const pending of this.#pending.values()) {
      pending.reject(new Error(`session closed: ${reason}`));
    }
    this.#pending.clear();

    try {
      this.#transport.close({ closeCode: 0, reason });
    } catch {
      // Already gone.
    }
  }

  async #unsubscribe(subscription: Subscription): Promise<void> {
    this.#byRequestId.delete(subscription.requestId);
    this.#byAlias.delete(subscription.trackAlias);

    if (this.#closed) return;
    try {
      await this.#controlWriter.write(encodeUnsubscribe(subscription.requestId));
      this.#log('info', `unsubscribed from ${subscription.track}`);
    } catch (error) {
      this.#log('warn', `failed to send UNSUBSCRIBE: ${describeError(error)}`);
    }
  }

  /** Dispatch control messages until the session ends. */
  async #runControlLoop(): Promise<void> {
    try {
      while (!this.#closed) {
        const message = await readControlMessage(this.#controlReader);
        this.#handleControlMessage(message.type, message.payload);
      }
    } catch (error) {
      if (!this.#closed) {
        this.#log('error', `control stream ended: ${describeError(error)}`);
        void this.close(describeError(error));
      }
    }
  }

  #handleControlMessage(type: number, payload: Uint8Array): void {
    switch (type) {
      case ControlMessageType.SubscribeOk: {
        const ok = decodeSubscribeOk(payload);
        this.#pending.get(ok.requestId)?.resolve({ trackAlias: ok.trackAlias });
        this.#pending.delete(ok.requestId);
        break;
      }

      case ControlMessageType.RequestError: {
        const error = decodeRequestError(payload);
        const pending = this.#pending.get(error.requestId);
        this.#pending.delete(error.requestId);
        pending?.reject(new Error(describeRequestError(error)));
        if (!pending) {
          this.#log('warn', `relay rejected an unknown request: ${describeRequestError(error)}`);
        }
        break;
      }

      case ControlMessageType.PublishDone: {
        // The publisher stopped serving a track we subscribed to. Objects stop
        // arriving but the session stays usable, so just surface it.
        this.#log('info', 'relay reported PUBLISH_DONE for a subscription');
        break;
      }

      case ControlMessageType.Goaway: {
        this.#log('warn', 'relay sent GOAWAY; reconnect to a new session');
        break;
      }

      default:
        // Everything else is either a response to a request we never make or a
        // publisher-side message. The length prefix already skipped it safely.
        break;
    }
  }

  /** Accept unidirectional streams and turn each one into a run of objects. */
  async #runDataLoop(): Promise<void> {
    const streams = this.#transport.incomingUnidirectionalStreams.getReader();

    try {
      while (!this.#closed) {
        const { done, value } = await streams.read();
        if (done) break;
        void this.#readDataStream(value as ReadableStream<Uint8Array>);
      }
    } catch (error) {
      if (!this.#closed) {
        this.#log('error', `stopped accepting data streams: ${describeError(error)}`);
      }
    }
  }

  async #readDataStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = new StreamReader(stream);

    try {
      const headerType = await reader.varint();
      const shape = subgroupStreamShape(headerType);
      if (!shape) {
        // FETCH streams (0x05) and anything unrecognised. We never send FETCH,
        // so there is nothing useful to do with the bytes.
        await reader.cancel('unsupported stream type');
        return;
      }

      const header = await readSubgroupHeader(reader, headerType);
      const subscription = await this.#resolveAlias(header.trackAlias);
      if (!subscription) {
        await reader.cancel('unknown track alias');
        return;
      }

      let previousObjectId: number | null = null;
      let subgroupId = header.subgroupId;

      for (;;) {
        const object = await readSubgroupObject(reader, shape, previousObjectId);
        if (!object) break;

        if (previousObjectId === null && shape.subgroupIdFromFirstObject) {
          // This header variant saves bytes by implying the subgroup ID.
          subgroupId = object.objectId;
        }
        previousObjectId = object.objectId;

        if (!subscription.active) break;

        subscription.objectCount += 1;
        subscription.byteCount += object.payload.length;

        subscription.handler({
          groupId: header.groupId,
          subgroupId,
          objectId: object.objectId,
          publisherPriority: header.publisherPriority,
          status: object.status,
          payload: object.payload,
          receivedAt: performance.now(),
        });

        if (object.status === ObjectStatus.EndOfTrack) break;
      }
    } catch (error) {
      if (!this.#closed) {
        this.#log('warn', `data stream aborted: ${describeError(error)}`);
      }
      await reader.cancel(describeError(error));
    }
  }

  /**
   * Look up a track alias, waiting briefly if the SUBSCRIBE_OK that assigns it
   * has not been processed yet.
   */
  async #resolveAlias(alias: number): Promise<Subscription | null> {
    const existing = this.#byAlias.get(alias);
    if (existing) return existing;

    return new Promise<Subscription | null>((resolve) => {
      const waiters = this.#aliasWaiters.get(alias) ?? [];
      const timer = setTimeout(() => {
        this.#removeAliasWaiter(alias, onResolved);
        this.#log('warn', `no subscription for track alias ${alias}; dropping its stream`);
        resolve(null);
      }, ALIAS_RESOLUTION_TIMEOUT_MS);

      function onResolved(subscription: Subscription): void {
        clearTimeout(timer);
        resolve(subscription);
      }

      waiters.push(onResolved);
      this.#aliasWaiters.set(alias, waiters);
    });
  }

  #resolveAliasWaiters(alias: number, subscription: Subscription): void {
    const waiters = this.#aliasWaiters.get(alias);
    if (!waiters) return;
    this.#aliasWaiters.delete(alias);
    for (const waiter of waiters) waiter(subscription);
  }

  #removeAliasWaiter(alias: number, waiter: (subscription: Subscription) => void): void {
    const waiters = this.#aliasWaiters.get(alias);
    if (!waiters) return;
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    if (waiters.length === 0) this.#aliasWaiters.delete(alias);
  }

  async #watchForClose(): Promise<void> {
    try {
      const info = await this.#transport.closed;
      this.#finishClose(info?.reason || 'session closed');
    } catch (error) {
      this.#finishClose(describeError(error));
    }
  }

  #finishClose(reason: string): void {
    if (!this.#closed) {
      this.#closed = true;
      for (const pending of this.#pending.values()) {
        pending.reject(new Error(`session closed: ${reason}`));
      }
      this.#pending.clear();
    }
    this.#options.onClose?.(reason);
  }

  #log(level: 'info' | 'warn' | 'error', message: string): void {
    this.#options.onLog?.(level, message);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
