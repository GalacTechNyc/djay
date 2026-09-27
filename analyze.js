// Waveform peaks + tempo/beat-grid detection for loaded tracks.

export const PEAKS_PER_SEC = 100;

export function computePeaks(L, R, sampleRate) {
  const bin = Math.max(1, Math.floor(sampleRate / PEAKS_PER_SEC));
  const n = Math.ceil(L.length / bin);
  const peaks = new Float32Array(n);
  let max = 1e-6;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const end = Math.min(L.length, (i + 1) * bin);
    for (let j = i * bin; j < end; j++) {
      const v = Math.abs(L[j]) + Math.abs(R[j]);
      if (v > m) m = v;
    }
    peaks[i] = m;
    if (m > max) max = m;
  }
  for (let i = 0; i < n; i++) peaks[i] /= max;
  return peaks;
}

// Returns { bpm, offset } where offset is the time (s) of a downbeat-ish beat.
export function detectTempo(L, sampleRate, bpmHint) {
  const fps = 400;
  const hop = Math.floor(sampleRate / fps);
  const frames = Math.min(Math.floor(L.length / hop), fps * 120);
  if (frames < fps * 4) return { bpm: 120, offset: 0 };

  // Onset strength: rectified rise in energy.
  const onset = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    const s = f * hop;
    for (let j = s; j < s + hop; j++) e += L[j] * L[j];
    e = Math.sqrt(e / hop);
    onset[f] = Math.max(0, e - prev);
    prev = e;
  }

  // Coarse: autocorrelation over 70–180 BPM, gently biased toward ~120.
  const minLag = Math.floor((60 * fps) / 180);
  const maxLag = Math.ceil((60 * fps) / 70);
  let bestLag = minLag;
  let bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let r = 0;
    for (let i = 0; i + lag < frames; i++) r += onset[i] * onset[i + lag];
    const bpm = (60 * fps) / lag;
    const bias = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.6, 2));
    r *= 0.6 + 0.4 * bias;
    if (r > bestScore) {
      bestScore = r;
      bestLag = lag;
    }
  }
  const coarse = bpmHint || (60 * fps) / bestLag;

  // Fine: comb search over tempo ±2% and every phase.
  let best = { score: -1, bpm: coarse, phase: 0 };
  for (let bpm = coarse * 0.98; bpm <= coarse * 1.02; bpm += 0.02) {
    const period = (60 * fps) / bpm;
    for (let phase = 0; phase < period; phase += 2) {
      let s = 0;
      for (let p = phase; p < frames; p += period) s += onset[p | 0];
      if (s > best.score) best = { score: s, bpm, phase };
    }
  }
  let bpm = best.bpm;
  if (Math.abs(bpm - Math.round(bpm)) < 0.15) bpm = Math.round(bpm);
  return { bpm, offset: best.phase / fps };
}
