/**
 * Integration test for the bot ↔ WASM local session pipeline. Exercises
 * the full Rust `connect_bot` / `handle_bot_packet` path through the TS
 * `LocalPreviewTransport` wrapper.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initWasmForTests } from '../../wasm/testInit';
import { LocalPreviewTransport } from '../../net/localPreviewTransport';
import { decodeServerPacket, type NetPlayerState, type ServerPacket } from '../../net/protocol';
import { buildInputFromButtons } from '../../scene/inputBuilder';
import { BTN_FORWARD } from '../../net/protocol';

interface SnapshotSample {
  players: NetPlayerState[];
}

function findPlayer(snapshot: SnapshotSample, id: number): NetPlayerState | null {
  return snapshot.players.find((p) => p.id === id) ?? null;
}

describe('WASM bot integration', () => {
  beforeAll(() => {
    initWasmForTests();
  });

  it('connects a bot and routes forward inputs through the KCC', async () => {
    const captured: ServerPacket[] = [];
    const transport = await LocalPreviewTransport.connect({
      onPacket: (packet) => captured.push(packet),
    });

    // Wait briefly for the initial welcome + a couple of ticks.
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Spawn a bot inside the session.
    const BOT_ID = 1_000_101;
    const ok = transport.connectBot(BOT_ID);
    expect(ok).toBe(true);
    // Duplicate rejected.
    expect(transport.connectBot(BOT_ID)).toBe(false);

    // Give the session time to emit a snapshot containing the bot.
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Find the most recent snapshot that contains our bot.
    const snapshots = captured.filter((p): p is ServerPacket & { type: 'snapshot' } => p.type === 'snapshot');
    expect(snapshots.length).toBeGreaterThan(0);
    const withBot = snapshots.find((snap) => snap.playerStates.some((p) => p.id === BOT_ID));
    expect(withBot, 'snapshot should include the bot as a player state').toBeTruthy();
    const initial = findPlayer({ players: withBot!.playerStates }, BOT_ID);
    expect(initial).not.toBeNull();
    const startZ = initial!.pzMm;

    // Push a forward-walking input for the bot.
    const cmd = buildInputFromButtons(1, 0, BTN_FORWARD, 0, 0);
    transport.sendBotInputs(BOT_ID, [cmd]);

    // Keep sending the same held-forward input so the bot accumulates
    // velocity through several ticks.
    for (let i = 2; i < 60; i += 1) {
      transport.sendBotInputs(BOT_ID, [
        buildInputFromButtons(i, 0, BTN_FORWARD, 0, 0),
      ]);
      if (i % 6 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    const latestSnapshots = captured.filter((p): p is ServerPacket & { type: 'snapshot' } => p.type === 'snapshot');
    const latestWithBot = latestSnapshots
      .slice()
      .reverse()
      .find((snap) => snap.playerStates.some((p) => p.id === BOT_ID));
    expect(latestWithBot).toBeTruthy();
    const final = findPlayer({ players: latestWithBot!.playerStates }, BOT_ID);
    expect(final).not.toBeNull();

    const movedMm = Math.abs(final!.pzMm - startZ);
    expect(movedMm, 'bot should have moved after a second of forward input').toBeGreaterThan(50);

    // Disconnect and verify the bot disappears from the next snapshot.
    expect(transport.disconnectBot(BOT_ID)).toBe(true);
    captured.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const postSnapshots = captured.filter((p): p is ServerPacket & { type: 'snapshot' } => p.type === 'snapshot');
    const anyBot = postSnapshots.find((snap) => snap.playerStates.some((p) => p.id === BOT_ID));
    expect(anyBot, 'bot should not appear in snapshots after disconnect').toBeFalsy();

    transport.close();
  }, 10_000);
});

// Keep decodeServerPacket referenced so tree-shaking doesn't drop the import
// (it's used indirectly by LocalPreviewTransport).
void decodeServerPacket;
