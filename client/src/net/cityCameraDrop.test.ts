import { expect, it } from 'vitest';
import { encodeCityCameraDrop, PKT_CITY_CAMERA_DROP } from './protocol';
it('encodes the city drop with the server float32 layout and no target player id', () => {
  const packet = encodeCityCameraDrop({ position: [12, 40, -8], yaw: 1, pitch: -0.4 });
  expect(packet.length).toBe(21);
  expect(packet[0]).toBe(PKT_CITY_CAMERA_DROP);
  const view = new DataView(packet.buffer);
  [12, 40, -8, 1, -0.4].forEach((value, i) => expect(view.getFloat32(1 + 4 * i, true)).toBeCloseTo(value));
});

it('keeps all packet identifiers unique, including existing city resync packets', async () => {
  const constants = await import('./sharedConstants');
  const ids = Object.entries(constants).filter(([name]) => name.startsWith('PKT_')).map(([, value]) => value);
  expect(new Set(ids).size).toBe(ids.length);
});
