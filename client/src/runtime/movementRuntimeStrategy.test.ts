import { describe, expect, it } from 'vitest';
import {
  CLIENT_MOVEMENT_FULL_PREDICTION,
  CLIENT_MOVEMENT_THIN_AUTHORITATIVE,
} from '../net/protocol';
import {
  shouldCreateGameplayWasmWorld,
  usesThinAuthoritativeRuntime,
} from './movementRuntimeStrategy';

describe('movement runtime strategy', () => {
  it('never constructs gameplay WASM physics for thin authoritative sessions', () => {
    const config = { client_movement_mode: CLIENT_MOVEMENT_THIN_AUTHORITATIVE };
    expect(usesThinAuthoritativeRuntime(config)).toBe(true);
    expect(shouldCreateGameplayWasmWorld(config)).toBe(false);
  });

  it('preserves the Rapier gameplay world for full prediction sessions', () => {
    const config = { client_movement_mode: CLIENT_MOVEMENT_FULL_PREDICTION };
    expect(usesThinAuthoritativeRuntime(config)).toBe(false);
    expect(shouldCreateGameplayWasmWorld(config)).toBe(true);
  });
});
