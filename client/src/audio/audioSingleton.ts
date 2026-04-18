import { AudioManager } from './AudioManager';

let _audio: AudioManager | null = null;

export function getAudio(): AudioManager {
  if (!_audio) {
    _audio = new AudioManager({ autoStartOnGesture: true });
  }
  return _audio;
}
