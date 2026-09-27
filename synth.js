// Built-in demo tracks, synthesized on the fly so the app works with zero
// audio files. Each one has an "ahh" vocal hit — the classic scratch sample.

export const DEMOS = [
  { id: 'demo-boom', title: 'Dusty Fingers', artist: 'Demo · Boom Bap', bpm: 92, style: 'boom', root: 45, loop: true },
  { id: 'demo-house', title: 'Neon Pulse', artist: 'Demo · House', bpm: 124, style: 'house', root: 43, loop: true },
  { id: 'demo-techno', title: 'Concrete 128', artist: 'Demo · Techno', bpm: 128, style: 'techno', root: 41, loop: true },
  { id: 'demo-trap', title: 'Glass Halo', artist: 'Demo · Trap', bpm: 140, style: 'trap', root: 38, loop: true },
];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const PROG = [0, 8, 3, 10]; // i – VI – III – VII
const chord = (root, semi) => (semi === 0 ? [0, 3, 7] : [0, 4, 7]).map((x) => root + semi + x);

class Synth {
  constructor(ctx, out) {
    this.c = ctx;
    this.out = out;
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  env(t, amp, attack, hold, release) {
    const g = this.c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + attack);
    g.gain.setValueAtTime(amp, t + attack + hold);
    g.gain.setTargetAtTime(0, t + attack + hold, release);
    return g;
  }

  kick(t, a = 1) {
    const o = this.c.createOscillator();
    const g = this.c.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.12);
    g.gain.setValueAtTime(a, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.42);
  }

  noiseHit(t, type, freq, q, amp, decay) {
    const s = this.c.createBufferSource();
    s.buffer = this.noise;
    const f = this.c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.c.createGain();
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    s.connect(f).connect(g).connect(this.out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + decay + 0.01);
  }

  snare(t, a = 0.7) {
    this.noiseHit(t, 'bandpass', 1800, 0.8, a, 0.18);
    const o = this.c.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 185;
    const g = this.c.createGain();
    g.gain.setValueAtTime(a * 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.1);
  }

  clap(t, a = 0.6) {
    for (const dt of [0, 0.011, 0.022]) this.noiseHit(t + dt, 'bandpass', 1100, 1.2, a, 0.03);
    this.noiseHit(t + 0.03, 'bandpass', 1100, 1.2, a * 0.8, 0.16);
  }

  hat(t, open = false, a = 0.2) {
    this.noiseHit(t, 'highpass', 7500, 0.7, a, open ? 0.22 : 0.035);
  }

  bass(t, midi, dur, a = 0.35) {
    const o = this.c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = mtof(midi);
    const f = this.c.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 6;
    f.frequency.setValueAtTime(900, t);
    f.frequency.setTargetAtTime(220, t, 0.06);
    const g = this.env(t, a, 0.004, dur, 0.03);
    o.connect(f).connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.2);
  }

  sub808(t, midi, dur, a = 0.75) {
    const o = this.c.createOscillator();
    const hz = mtof(midi);
    o.frequency.setValueAtTime(hz * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(hz, t + 0.05);
    const g = this.env(t, a, 0.003, dur * 0.6, dur * 0.25);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur * 1.5);
  }

  stab(t, notes, dur, a = 0.07, cutoff = 2200) {
    const f = this.c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = this.env(t, a, 0.005, dur, 0.05);
    f.connect(g).connect(this.out);
    for (const n of notes) {
      for (const det of [-7, 7]) {
        const o = this.c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(n);
        o.detune.value = det;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.4);
      }
    }
  }

  // Formant-filtered sawtooth — a synthetic "ahhh" vocal.
  ahh(t, midi, dur, a = 0.9) {
    const o = this.c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = mtof(midi);
    const lfo = this.c.createOscillator();
    lfo.frequency.value = 5.5;
    const lfoAmt = this.c.createGain();
    lfoAmt.gain.value = 4;
    lfo.connect(lfoAmt).connect(o.frequency);
    const g = this.env(t, a, 0.02, dur, 0.06);
    g.connect(this.out);
    for (const [freq, amt] of [[800, 1], [1150, 0.6], [2900, 0.25]]) {
      const f = this.c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq;
      f.Q.value = 9;
      const fg = this.c.createGain();
      fg.gain.value = amt;
      o.connect(f).connect(fg).connect(g);
    }
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.4);
    lfo.stop(t + dur + 0.4);
  }
}

const PATTERNS = {
  boom(S, { s, bar, t, sd, root, semi, intro }) {
    if ([0, 7, 10].includes(s)) S.kick(t);
    if (s === 4 || s === 12) S.snare(t, 0.8);
    if (s % 2 === 0) S.hat(t, false, s % 4 === 0 ? 0.2 : 0.12);
    if (!intro && [0, 7, 10].includes(s)) S.bass(t, root - 12, sd * 2.5);
    if (!intro && s === 0) S.stab(t, chord(root + 12, semi), sd * 6, 0.06, 1400);
    if (bar % 2 === 1 && s === 8) S.ahh(t, root + 12, sd * 3.5);
  },
  house(S, { s, bar, t, sd, root, semi, intro }) {
    if (s % 4 === 0) S.kick(t);
    if (s === 4 || s === 12) S.clap(t);
    if (s % 4 === 2) S.hat(t, true, 0.16);
    else S.hat(t, false, 0.07);
    if (!intro && s % 4 === 2) S.bass(t, root - 12 + (s === 14 ? 12 : 0), sd * 1.2);
    if (!intro && (s === 3 || s === 10)) S.stab(t, chord(root + 12, semi), sd * 1.2);
    if (bar % 4 === 3 && s === 0) S.ahh(t, root + 15, sd * 4);
  },
  techno(S, { s, bar, t, sd, root, intro }) {
    if (s % 4 === 0) S.kick(t);
    S.hat(t, s % 4 === 2, s % 4 === 2 ? 0.14 : s % 2 ? 0.05 : 0.09);
    if (bar % 2 && s === 12) S.clap(t, 0.45);
    if (!intro && s % 4 !== 0) S.bass(t, root - 12, sd * 0.6, 0.22);
    if (!intro && [3, 6, 11].includes(s)) S.stab(t, [root + 15], sd, 0.08, 3000);
    if (bar % 4 === 0 && s === 8) S.ahh(t, root + 12, sd * 3);
  },
  trap(S, { s, bar, t, sd, root, semi, intro }) {
    const kicks = [0, 7, 10];
    if (kicks.includes(s)) S.kick(t, 0.9);
    if (s === 8) S.clap(t, 0.7);
    if (bar % 2 === 1 && s >= 12) {
      S.hat(t, false, 0.12);
      S.hat(t + sd / 2, false, 0.1);
    } else if (s % 2 === 0) S.hat(t, false, 0.13);
    if (!intro && kicks.includes(s)) {
      const next = kicks.find((k) => k > s) ?? 16;
      S.sub808(t, root - 12 + semi, (next - s) * sd);
    }
    if (!intro && s === 0) S.stab(t, chord(root + 24, semi), sd * 14, 0.035, 1800);
    if (bar % 2 === 0 && s === 4) S.ahh(t, root + 19, sd * 3);
  },
};

export async function renderDemo(track, sampleRate = 44100) {
  const bars = 16;
  const sd = 60 / track.bpm / 4; // one 16th note
  const len = bars * 16 * sd;
  const ctx = new OfflineAudioContext(2, Math.ceil(len * sampleRate), sampleRate);

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.ratio.value = 4;
  const out = ctx.createGain();
  out.gain.value = 0.7;
  out.connect(comp).connect(ctx.destination);

  const S = new Synth(ctx, out);
  const swing = track.style === 'boom' ? sd * 0.14 : 0;
  const pattern = PATTERNS[track.style];
  for (let bar = 0; bar < bars; bar++) {
    const semi = PROG[(track.style === 'boom' ? bar >> 1 : bar) % 4];
    for (let s = 0; s < 16; s++) {
      const t = (bar * 16 + s) * sd + (s % 2 ? swing : 0);
      pattern(S, { s, bar, t, sd, root: track.root, semi, intro: bar < 2 });
    }
  }
  return ctx.startRendering();
}
