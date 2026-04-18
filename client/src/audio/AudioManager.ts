// Inspired by Kinema's AudioManager (MIT). Re-written to drop couplings to
// Kinema's EventBus / PlayerController / InputManager / VehicleController.
// See CREDITS.md at the repo root.
//
// This manager wires the Tone.js-based SFX and Music engines into a master
// bus with a Safari-safe dynamics stage, and defers audio-context start
// until the first user gesture. Game code consumes `audio.sfx` and
// `audio.music` directly — there is no built-in event bus.

import * as Tone from 'tone';
import { createSafeDynamicsStage } from './createSafeDynamicsStage';
import { MusicEngine } from './MusicEngine';
import { SFXEngine } from './SFXEngine';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface AudioManagerOptions {
  masterVolume?: number;
  musicVolume?: number;
  sfxVolume?: number;
  /** Auto-attach listeners to the first user gesture to start Tone. Default true. */
  autoStartOnGesture?: boolean;
}

export class AudioManager {
  readonly sfx: SFXEngine;
  readonly music: MusicEngine;

  private masterGain: Tone.Gain;
  private sfxGain: Tone.Gain;
  private musicGain: Tone.Gain;
  private masterCompressor: Tone.Compressor | Tone.Gain;
  private masterLimiter: Tone.Limiter | Tone.Gain;
  private unsubscribers: Array<() => void> = [];
  private toneStarted = false;
  private pendingMusicFadeIn: number | null = null;

  constructor(options: AudioManagerOptions = {}) {
    const {
      masterVolume = 0.8,
      musicVolume = 0.6,
      sfxVolume = 0.8,
      autoStartOnGesture = true,
    } = options;

    const dynamicsStage = createSafeDynamicsStage(
      'Master bus',
      { threshold: -24, ratio: 3, attack: 0.003, release: 0.12 },
      { threshold: -1 },
    );
    this.masterCompressor = dynamicsStage.compressor;
    this.masterLimiter = dynamicsStage.limiter;
    if (dynamicsStage.degraded) {
      console.warn(
        '[AudioManager] Master dynamics processing disabled on this device for compatibility.',
      );
    }

    this.masterGain = new Tone.Gain(1);
    this.masterGain.chain(
      this.masterCompressor,
      this.masterLimiter,
      Tone.getDestination(),
    );

    // SFX base offset ~-2dB, Music base offset ~-6dB (same scaling as Kinema).
    this.sfxGain = new Tone.Gain(0.79).connect(this.masterGain);
    this.musicGain = new Tone.Gain(0.5).connect(this.masterGain);

    this.sfx = new SFXEngine();
    this.sfx.output.connect(this.sfxGain);

    this.music = new MusicEngine();
    this.music.output.connect(this.musicGain);

    this.setMasterVolume(masterVolume);
    this.setMusicVolume(musicVolume);
    this.setSfxVolume(sfxVolume);

    if (autoStartOnGesture) {
      this.listenForUserGesture();
    }
  }

  /**
   * Explicitly start the Tone audio context. Must be called from a user
   * gesture (click, keydown, pointerdown). The auto-gesture listener calls
   * this for you unless you disabled it.
   */
  async start(): Promise<void> {
    await this.ensureToneStarted();
  }

  playMusic(fadeInSec = 2.0): void {
    if (!this.toneStarted) {
      this.pendingMusicFadeIn = fadeInSec;
      void this.ensureToneStarted();
      return;
    }
    this.music.start(fadeInSec);
  }

  stopMusic(fadeOutSec = 1.5): void {
    this.music.stop(fadeOutSec);
  }

  setMasterVolume(value: number): void {
    this.masterGain.gain.rampTo(clamp(value, 0, 1), 0.05);
  }

  setMusicVolume(value: number): void {
    this.musicGain.gain.rampTo(clamp(value, 0, 1) * 0.5, 0.05);
  }

  setSfxVolume(value: number): void {
    this.sfxGain.gain.rampTo(clamp(value, 0, 1) * 0.79, 0.05);
  }

  get isStarted(): boolean {
    return this.toneStarted;
  }

  dispose(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.music.dispose();
    this.sfx.dispose();
    this.musicGain.dispose();
    this.sfxGain.dispose();
    this.masterCompressor.dispose();
    this.masterLimiter.dispose();
    this.masterGain.dispose();
  }

  private async ensureToneStarted(): Promise<void> {
    if (this.toneStarted) return;
    try {
      if (Tone.getContext().state !== 'running') {
        await Tone.start();
      }
      this.toneStarted = true;
      if (this.pendingMusicFadeIn !== null) {
        const fade = this.pendingMusicFadeIn;
        this.pendingMusicFadeIn = null;
        this.music.start(fade);
      }
    } catch {
      // Will retry on the next gesture.
    }
  }

  private listenForUserGesture(): void {
    const gestureEvents = [
      'click',
      'keydown',
      'touchstart',
      'pointerdown',
    ] as const;
    const handler = (): void => {
      for (const evt of gestureEvents) {
        document.removeEventListener(evt, handler, true);
      }
      void this.ensureToneStarted();
    };
    for (const evt of gestureEvents) {
      document.addEventListener(evt, handler, { capture: true, once: false });
    }
    this.unsubscribers.push(() => {
      for (const evt of gestureEvents) {
        document.removeEventListener(evt, handler, true);
      }
    });
  }
}
