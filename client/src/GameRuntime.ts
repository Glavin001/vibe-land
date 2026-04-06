import * as RAPIER from '@dimforge/rapier3d-compat';

import { GameSocket } from './net/gameSocket';
import { SnapshotInterpolator } from './net/interpolation';
import { buildGameplayWsUrl, connectSpacetime } from './spacetime/connectSpacetime';
import { PredictedFpsController, buildInputFromButtons } from './physics/predictedFpsController';
import { netStateToMeters, type ServerPacket } from './net/protocol';
import { ClientVoxelWorld } from './world/voxelWorld';

/**
 * Thin glue example showing how the provided pieces fit together.
 * Your real project should wrap this with React state, ECS/component state, and R3F objects.
 */
export class GameRuntime {
  private readonly socket = new GameSocket({
    onPacket: (packet) => this.onPacket(packet),
    onRttUpdated: (rttMs) => { this.latestClientRttMs = rttMs; },
  });

  private readonly interpolator = new SnapshotInterpolator();
  private readonly predictionWorld = new RAPIER.World({ x: 0, y: -20, z: 0 });
  private readonly voxelWorld = new ClientVoxelWorld(this.predictionWorld);

  private playerId = 0;
  private latestServerTick = 0;
  private latestClientRttMs = 0;
  private nextInputSeq = 1;
  private predictedController: PredictedFpsController | null = null;

  async start(config: {
    spacetimeHost: string;
    spacetimeDatabase: string;
    gameplayWsBase: string;
    matchId: string;
  }): Promise<void> {
    await RAPIER.init();

    connectSpacetime({
      host: config.spacetimeHost,
      databaseName: config.spacetimeDatabase,
      matchId: config.matchId,
      onReady: ({ identity, token }) => {
        this.socket.connect(buildGameplayWsUrl(config.gameplayWsBase, config.matchId, identity, token));
      },
    });

    const body = this.predictionWorld.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    const collider = this.predictionWorld.createCollider(RAPIER.ColliderDesc.capsule(0.45, 0.35), body);
    this.predictedController = new PredictedFpsController(this.predictionWorld, body, collider);
  }

  fixedUpdate(localButtons: number, yaw: number, pitch: number): void {
    if (!this.predictedController || !this.playerId) return;

    const seq = this.nextInputSeq = (this.nextInputSeq + 1) & 0xffff;
    const clientTick = Math.floor(performance.now() / (1000 / 60));
    const input = buildInputFromButtons(seq, clientTick, localButtons, yaw, pitch);

    this.predictedController.predict(input, 1 / 60);
    this.socket.sendInput(input);
  }

  sampleRemotePlayer(playerId: number, interpolationDelayTicks = 4) {
    return this.interpolator.sample(playerId, this.latestServerTick - interpolationDelayTicks);
  }

  getLocalPredictedPose() {
    if (!this.predictedController) return null;
    const pos = this.predictedController.getPosition();
    const vel = this.predictedController.getVelocity();
    const angles = this.predictedController.getAngles();
    return { pos, vel, angles, grounded: this.predictedController.isGrounded() };
  }

  private onPacket(packet: ServerPacket): void {
    switch (packet.type) {
      case 'welcome':
        this.playerId = packet.playerId;
        break;
      case 'snapshot': {
        this.latestServerTick = packet.serverTick;
        for (const state of packet.playerStates) {
          const meters = netStateToMeters(state);
          if (state.id === this.playerId && this.predictedController) {
            this.predictedController.reconcile({ ackInputSeq: packet.ackInputSeq, state }, 1 / 60);
          } else {
            this.interpolator.push(state.id, {
              serverTick: packet.serverTick,
              receivedAtMs: performance.now(),
              position: meters.position,
              velocity: meters.velocity,
              yaw: meters.yaw,
              pitch: meters.pitch,
              hp: meters.hp,
              flags: meters.flags,
            });
          }
        }
        break;
      }
      case 'chunkFull':
        this.voxelWorld.applyFullChunk(packet);
        break;
      case 'chunkDiff':
        try {
          this.voxelWorld.applyChunkDiff(packet);
        } catch (error) {
          console.warn('Chunk diff rejected on client, waiting for authoritative full chunk', error);
        }
        break;
      case 'shotResult':
        console.log('shot result', packet);
        break;
      case 'pong':
      case 'serverPing':
        break;
    }
  }
}
