import { useEffect, useRef, useState } from 'react';
import { destructionAudio } from './engine';
import { channelCount, SPEAKERS_71 } from './spatial';
import { setAudioSettings, setMixPreset, useAudioSettings, type AudioSettings, type MixPreset, type OutputMode, type DynamicRange } from './settings';
import './AudioSettingsPanel.css';

export const MIX_LABELS: Record<MixPreset, { name: string; detail: string }> = {
  cinematic: { name: 'Cinematic', detail: 'Weight & scale' },
  natural: { name: 'Natural', detail: 'Texture & detail' },
  clarity: { name: 'Clarity', detail: 'Close danger first' },
};
const CHANNELS = ['Front left', 'Front right', 'Center', 'Subwoofer', 'Surround left', 'Surround right', 'Rear left', 'Rear right'];

export function AudioMixControls({ showPresets = true, onPreset }: { showPresets?: boolean; onPreset?: (preset: MixPreset) => void }) {
  const settings = useAudioSettings();
  const [notice, setNotice] = useState('');
  const [diagnostics, setDiagnostics] = useState(() => destructionAudio().diagnostics());
  useEffect(() => { const timer = window.setInterval(() => setDiagnostics(destructionAudio().diagnostics()), 500); return () => window.clearInterval(timer); }, []);
  const slider = (key: 'master' | 'impact' | 'detail' | 'bass' | 'space' | 'flyby' | 'ringing', label: string, hint?: string) => (
    <label className="sound-slider" key={key}>
      <span>{label}<output>{Math.round(settings[key] * 100)}%</output></span>
      <input aria-label={label} type="range" min="0" max={key === 'master' || key === 'ringing' ? 1 : 1.5} step="0.01" value={settings[key]} onChange={e => setAudioSettings({ [key]: Number(e.target.value) } as Partial<AudioSettings>)} />
      {hint && <small>{hint}</small>}
    </label>
  );
  const channels = diagnostics.output === 'surround71' ? CHANNELS.map((label, index) => SPEAKERS_71.find(s => s.channel === index)?.name ?? label) : CHANNELS;
  async function testChannel(index: number) {
    try { await destructionAudio().start(); destructionAudio().testChannel(index); setNotice(`Playing ${channels[index].toLowerCase()}.`); }
    catch { setNotice('Sound could not start. Please retry.'); }
  }
  return <div className="sound-controls">
    <label className="sound-enabled"><span>Game sound</span><input type="checkbox" checked={settings.enabled} onChange={e => setAudioSettings({ enabled: e.target.checked })} /><span>{settings.enabled ? 'On' : 'Muted'}</span></label>
    {slider('master', 'Master volume')}
    {showPresets && <fieldset className="sound-preset-field"><legend>Mix character</legend><div className="sound-presets">{(Object.keys(MIX_LABELS) as MixPreset[]).map(preset => <button type="button" key={preset} aria-pressed={settings.preset === preset} onClick={() => onPreset ? onPreset(preset) : setMixPreset(preset)}>{MIX_LABELS[preset].name}<small>{MIX_LABELS[preset].detail}</small></button>)}</div></fieldset>}
    <div className="sound-select-row"><label>Listening setup<select value={settings.output} onChange={e => setAudioSettings({ output: e.target.value as OutputMode })}><option value="headphones">Headphones · 3D binaural</option><option value="stereo">Stereo speakers</option><option value="surround51">5.1 surround</option><option value="surround71">7.1 surround</option></select></label><label>Dynamic range<select value={settings.dynamicRange} onChange={e => setAudioSettings({ dynamicRange: e.target.value as DynamicRange })}><option value="cinematic">Cinematic · widest contrast</option><option value="balanced">Balanced</option><option value="night">Night · restrained peaks</option></select></label></div>
    {diagnostics.sampleRate > 0 && diagnostics.requestedOutput.startsWith('surround') && diagnostics.requestedOutput !== diagnostics.output && <p className="sound-notice" role="status">Your browser currently exposes {diagnostics.maxChannels} channels. Playback is using {diagnostics.output === 'stereo' ? 'stereo' : diagnostics.output}; the selected surround mode needs a compatible output device.</p>}
    <details className="sound-details"><summary>Shape the mix</summary><div className="sound-detail-grid">{slider('impact', 'Impact')}{slider('detail', 'Debris & friction')}{slider('bass', 'Weight')}{slider('space', 'Reflections')}{slider('flyby', 'Near misses')}{slider('ringing', 'Impact ringing', 'Optional, brief ear-ringing effect. Off by default.')}</div><label className="sound-budget">Voice budget<select value={settings.maxVoices} onChange={e => setAudioSettings({ maxVoices: Number(e.target.value) })}>{[24, 32, 48, 64, 80, 96].map(n => <option key={n} value={n}>{n} voices</option>)}</select></label></details>
    <details className="sound-details"><summary>Check speaker routing</summary><p className="sound-caption">Use your device’s normal speaker setup. Each button plays a short test tone. Surround channel placement must be checked on your physical speakers.</p><div className="sound-channels">{channels.slice(0, channelCount(diagnostics.output)).map((channel, i) => <button key={channel} type="button" onClick={() => void testChannel(i)}>{channel}</button>)}</div><p className="sound-caption" role="status">{notice || `Active output: ${diagnostics.output} · ${channelCount(diagnostics.output)} channels`}</p></details>
  </div>;
}

export function AudioSettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return <dialog ref={dialog} className="sound-dialog" aria-labelledby="sound-settings-title" onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="sound-dialog-body"><header><div><span className="sound-eyebrow">VIBE-LAND / AUDIO</span><h2 id="sound-settings-title">Sound settings</h2></div><button type="button" aria-label="Close sound settings" onClick={onClose}>×</button></header>
      {open && <AudioMixControls />}
      <footer><a href="/audio" target="_blank" rel="noreferrer">Open the listening lab ↗</a><button type="button" onClick={onClose}>Done</button></footer>
    </div>
  </dialog>;
}
