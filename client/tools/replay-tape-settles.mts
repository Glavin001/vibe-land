/**
 * Replay a recorded VLTAPE through the REAL city client and report what the
 * settle path did with it: how many settles were refused as membership faults
 * (each one a structure repair request), how many were applied as
 * relocations, and how far the stream had fallen behind. No rendering.
 *
 *   npx tsx tools/replay-tape-settles.mts --tape city.vltape --manifest city-manifest.bin
 *
 * The manifest is the binary the server serves at /city-manifest/<hash>; the
 * tape header names the hash. Packets are fed in arrival order with the
 * client's clock set to each packet's tape time, so the 3.0 s repair
 * rate-limiter behaves as it did on the reporter's machine. Resync requests
 * the client would have sent are counted and decoded, never answered: on the
 * live session the answers were the structure bootstraps already in the tape.
 */
import { readFileSync } from 'node:fs';

let fakeNowMs = 0;
(globalThis.performance as { now: () => number }).now = () => fakeNowMs;

const { decodeCityTape } = await import('../src/city/cityTape.ts');
const { parseCityManifestBytes } = await import('../src/city/manifest.ts');
const { CityClient } = await import('../src/city/cityClient.ts');

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing ${name} <value>`);
  return process.argv[index + 1];
}

const tape = decodeCityTape(new Uint8Array(readFileSync(arg('--tape'))));
const manifestBytes = readFileSync(arg('--manifest'));
const loaded = await parseCityManifestBytes(
  manifestBytes.buffer.slice(manifestBytes.byteOffset, manifestBytes.byteOffset + manifestBytes.byteLength),
  tape.header.manifestHash,
);

const resyncs: Array<{ atMs: number; structures: number[] }> = [];
const client = new CityClient(
  loaded,
  (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const structures: number[] = [];
    if (bytes.length > 5) {
      const count = view.getUint8(5);
      for (let i = 0; i < count; i += 1) structures.push(view.getUint32(6 + i * 4, true));
    }
    resyncs.push({ atMs: fakeNowMs, structures });
  },
);

for (let index = 0; index < tape.packets.length; index += 1) {
  fakeNowMs = tape.times[index];
  client.handlePacket(tape.packets[index]);
}

const stats = client.stats() as unknown as Record<string, number>;
const topology = client.topology;
console.log(
  JSON.stringify(
    {
      tape: tape.header.capturedAt,
      durationMs: Math.round(tape.header.durationMs),
      packets: tape.packets.length,
      hashChecks: stats.hashChecks,
      hashMismatches: stats.hashMismatches,
      settleRejects: topology.settleFrameRejects,
      settleRelocations: topology.settleRelocations ?? 0,
      settleRelocationWorstM: Number((topology.settleRelocationWorstM ?? 0).toFixed(2)),
      migrateAnomalies: topology.migrateAnomalies,
      structureRepairRequests: resyncs.filter((r) => r.structures.length > 0).length,
      fullResyncRequests: resyncs.filter((r) => r.structures.length === 0).length,
      repairRequestTimesS: resyncs
        .filter((r) => r.structures.length > 0)
        .map((r) => Number((r.atMs / 1000).toFixed(1))),
      structuresRepaired: [...new Set(resyncs.flatMap((r) => r.structures))].sort((a, b) => a - b),
    },
    null,
    1,
  ),
);
