/**
 * Tiny WebAudio sound engine. Sounds are synthesized so the project ships with
 * zero binary assets and stays fully offline. All playback is a no-op when muted
 * or when the AudioContext is unavailable.
 */
let ctx: AudioContext | null = null;
let muted = false;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

export function setMuted(value: boolean): void {
  muted = value;
}

function tone(freq: number, durationMs: number, type: OscillatorType, gain = 0.06): void {
  if (muted) return;
  const ac = getCtx();
  if (!ac) return;
  if (ac.state === 'suspended') void ac.resume();

  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(gain, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + durationMs / 1000);
  osc.connect(g);
  g.connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + durationMs / 1000);
}

export const sound = {
  deal: () => tone(420, 70, 'triangle', 0.04),
  check: () => tone(300, 90, 'sine', 0.05),
  call: () => tone(520, 110, 'sine', 0.05),
  bet: () => tone(660, 120, 'square', 0.04),
  chips: () => {
    tone(740, 60, 'triangle', 0.04);
    setTimeout(() => tone(880, 60, 'triangle', 0.03), 50);
  },
  fold: () => tone(220, 130, 'sawtooth', 0.035),
  win: () => {
    tone(523, 120, 'sine', 0.06);
    setTimeout(() => tone(659, 120, 'sine', 0.06), 110);
    setTimeout(() => tone(784, 180, 'sine', 0.06), 220);
  },
  lose: () => tone(196, 220, 'sine', 0.045),
};
