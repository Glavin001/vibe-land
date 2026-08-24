/**
 * Every Vast.ai REST call the control plane makes.
 *
 * The Vast API is v0 and has changed shape before, so all of it is quarantined
 * here: an upstream change is a one-file fix, and `mock-vast/server.mjs` only
 * has to mirror this one file to make local end-to-end runs faithful.
 *
 * `baseUrl` is injectable for exactly that reason -- point it at the mock and
 * the entire lifecycle runs offline.
 */

export interface Offer {
  id: number;
  machineId: number;
  dphTotal: number;
  gpuName: string;
  geolocation: string;
}

export interface Instance {
  id: number;
  /** Vast's own words: 'loading' | 'running' | 'exited' | 'created' | ... */
  actualStatus: string;
  statusMsg: string | null;
  publicIpaddr: string | null;
  label: string | null;
  dphTotal: number | null;
}

export interface CreateInstanceOptions {
  image: string;
  diskGb: number;
  label: string;
  env: Record<string, string>;
  /** Internal container ports to publish. Vast maps each to a random external port. */
  tcpPorts: number[];
  udpPorts: number[];
  registryUser?: string;
  registryToken?: string;
}

export class VastAuthError extends Error {}

export class VastApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Delete raced with a delete that already landed. Treated as success. */
export class VastNotFoundError extends Error {}

export class VastClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 401 || response.status === 403) {
      // Almost always an exhausted balance or a rotated key -- the one failure
      // here a human has to fix, so it gets its own type.
      throw new VastAuthError(`vast auth failed (${response.status}) on ${method} ${path}`);
    }
    if (response.status === 404) {
      throw new VastNotFoundError(`vast 404 on ${method} ${path}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new VastApiError(
        `vast ${response.status} on ${method} ${path}: ${text.slice(0, 200)}`,
        response.status,
      );
    }
    return response.json().catch(() => ({}));
  }

  /**
   * Cheapest rentable on-demand offers that can actually host this workload.
   *
   * Filters are deliberately strict: interruptible instances would vanish
   * mid-match, and an unverified host can have UDP blocked, which breaks
   * WebTransport with no useful error at the client.
   */
  async searchOffers(options: { minGpuRamMb?: number; limit?: number } = {}): Promise<Offer[]> {
    const query = {
      verified: { eq: true },
      rentable: { eq: true },
      rented: { eq: false },
      datacenter: { eq: true },
      reliability2: { gte: 0.98 },
      gpu_ram: { gte: options.minGpuRamMb ?? 24000 },
      inet_down: { gte: 300 },
      type: 'on-demand',
      order: [['dph_total', 'asc']],
      limit: options.limit ?? 20,
    };
    const data = await this.call('PUT', '/api/v0/bundles/', query);
    const offers = Array.isArray(data?.offers) ? data.offers : [];
    return offers.map(
      (offer: any): Offer => ({
        id: Number(offer.id),
        machineId: Number(offer.machine_id),
        dphTotal: Number(offer.dph_total ?? 0),
        gpuName: String(offer.gpu_name ?? ''),
        geolocation: String(offer.geolocation ?? ''),
      }),
    );
  }

  /**
   * Rent one offer.
   *
   * No Vast template is involved: image, disk, ports, and env all go in this
   * call, which keeps the deployable surface to "an image tag in a Worker var"
   * instead of a second piece of versioned infrastructure.
   */
  async createInstance(offerId: number, options: CreateInstanceOptions): Promise<number> {
    const ports = [
      ...options.tcpPorts.map((port) => `-p ${port}:${port}`),
      ...options.udpPorts.map((port) => `-p ${port}:${port}/udp`),
    ].join(' ');

    const body: Record<string, unknown> = {
      client_id: 'me',
      image: options.image,
      disk: options.diskGb,
      label: options.label,
      env: options.env,
      runtype: 'args',
      onstart: null,
      // Vast reads published ports out of the docker options string; the `env`
      // map above covers variables only.
      extra_env: options.env,
      docker_options: ports,
      use_ssh: false,
    };
    if (options.registryUser && options.registryToken) {
      body.login = `-u ${options.registryUser} -p ${options.registryToken} ghcr.io`;
    }

    const data = await this.call('PUT', `/api/v0/asks/${offerId}/`, body);
    const id = Number(data?.new_contract ?? data?.instance_id ?? 0);
    if (!id) {
      throw new VastApiError(`vast create returned no instance id: ${JSON.stringify(data)}`, 200);
    }
    return id;
  }

  async getInstance(instanceId: number): Promise<Instance> {
    const data = await this.call('GET', `/api/v0/instances/${instanceId}/`);
    const raw = data?.instances ?? data;
    return normalizeInstance(raw);
  }

  /**
   * Used to recover from an eviction between "create sent" and "id stored":
   * the label carries our own id, so a rental we already paid for can be
   * re-adopted instead of orphaned and duplicated.
   */
  async listInstances(): Promise<Instance[]> {
    const data = await this.call('GET', '/api/v0/instances/');
    const list = Array.isArray(data?.instances) ? data.instances : [];
    return list.map(normalizeInstance);
  }

  /** Destroy, never stop: a stopped instance still bills for disk. */
  async destroyInstance(instanceId: number): Promise<void> {
    try {
      await this.call('DELETE', `/api/v0/instances/${instanceId}/`);
    } catch (error) {
      if (error instanceof VastNotFoundError) return;
      throw error;
    }
  }
}

function normalizeInstance(raw: any): Instance {
  return {
    id: Number(raw?.id ?? 0),
    actualStatus: String(raw?.actual_status ?? raw?.cur_state ?? 'unknown'),
    statusMsg: raw?.status_msg ?? null,
    publicIpaddr: raw?.public_ipaddr ?? null,
    label: raw?.label ?? null,
    dphTotal: raw?.dph_total === undefined ? null : Number(raw.dph_total),
  };
}

/** Vast words that mean "this container is not coming back". */
export function isDeadStatus(status: string): boolean {
  return status === 'exited' || status === 'error' || status === 'offline';
}
