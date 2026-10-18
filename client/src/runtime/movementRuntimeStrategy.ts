import { CLIENT_MOVEMENT_THIN_AUTHORITATIVE } from '../net/protocol';
import type { SessionConfigResponse } from '../net/webTransportClient';

export function usesThinAuthoritativeRuntime(
  config: Pick<SessionConfigResponse, 'client_movement_mode'>,
): boolean {
  return config.client_movement_mode === CLIENT_MOVEMENT_THIN_AUTHORITATIVE;
}

export function shouldCreateGameplayWasmWorld(
  config: Pick<SessionConfigResponse, 'client_movement_mode'>,
): boolean {
  return !usesThinAuthoritativeRuntime(config);
}
