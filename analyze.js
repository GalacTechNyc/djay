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
//
// 1. Onset envelope (400 per second) mixing full-band attacks with the kick
//    drum band, which defines the beat in most dance music.
// 2. Coarse tempo by autocorrelation in several ~20 s sections; the median
//    of those votes resists breakdowns and odd intros.
// 3. Fine comb search (tempo ±2% × every phase) over the whole track.
// 4. Whole-number preference: most tracks are produced at an integer BPM.
export function detectTempo(L, sampleRate, bpmHint) {
  const hop = Math.floor(sampleRate / 400);
  // The real analysis rate: sampleRate / hop (≈400.9 at 44.1 kHz). Using a
  // rounded 400 here made every tempo read ~0.23% slow.
  const fps = sampleRate / hop;
  const frames = Math.min(Math.floor(L.length / hop), Math.floor(fps * 360));
  if (frames < fps * 4) return { bpm: bpmHint || 120, offset: 0 };

  const onset = onsetEnvelope(L, sampleRate, hop, frames);

  let coarse = bpmHint;
  if (!coarse) {
    const win = Math.floor(fps * 20);
    const votes = [];
    if (frames <= win * 1.5) votes.push(autocorrBpm(onset, 0, frames, fps));
    else {
      const n = Math.min(8, Math.floor(frames / win));
      for (let k = 0; k < n; k++) {
        const start = Math.floor(((frames - win) * (k + 0.5)) / n);
        votes.push(autocorrBpm(onset, start, start + win, fps));
      }
    }
    // Fold every vote into the octave of the first one, then take the median.
    const ref = votes[0];
    const folded = votes.map((b) => {
      while (b / ref > 1.41) b /= 2;
      while (b / ref < 0.71) b *= 2;
      return b;
    });
    folded.sort((a, b) => a - b);
    coarse = folded[Math.floor(folded.length / 2)];
    while (coarse < 80) coarse *= 2;
    while (coarse >= 170) coarse /= 2;
  }

  const comb = (bpm) => {
    const period = (60 * fps) / bpm;
    let best = { score: -1, phase: 0 };
    for (let phase = 0; phase < period; phase += 2) {
      let s = 0;
      for (let p = phase; p < frames; p += period) s += onset[p | 0];
      if (s > best.score) best = { score: s, phase };
    }
    return best;
  };

  let best = { score: -1, bpm: coarse, phase: 0 };
  for (let bpm = coarse * 0.98; bpm <= coarse * 1.02; bpm += 0.02) {
    const r = comb(bpm);
    if (r.score > best.score) best = { ...r, bpm };
  }
  const whole = Math.round(best.bpm);
  if (Math.abs(whole - best.bpm) < 0.6) {
    const r = comb(whole);
    if (r.score >= best.score * 0.97) best = { ...r, bpm: whole };
  }
  return { bpm: best.bpm, offset: best.phase / fps };
}

function onsetEnvelope(L, sampleRate, hop, frames) {
  const full = new Float32Array(frames);
  const low = new Float32Array(frames);
  const a = 1 - Math.exp((-2 * Math.PI * 150) / sampleRate); // one-pole low-pass, kick band
  let lp = 0;
  let prevF = 0;
  let prevL = 0;
  let sumF = 1e-9;
  let sumL = 1e-9;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    let el = 0;
    const s = f * hop;
    for (let j = s; j < s + hop; j++) {
      const x = L[j];
      lp += a * (x - lp);
      e += x * x;
      el += lp * lp;
    }
    e = Math.sqrt(e / hop);
    el = Math.sqrt(el / hop);
    full[f] = Math.max(0, e - prevF);
    low[f] = Math.max(0, el - prevL);
    prevF = e;
    prevL = el;
    sumF += full[f];
    sumL += low[f];
  }
  // Equal weight for both bands after normalising, kick counted a bit more.
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) out[f] = full[f] / sumF + (1.5 * low[f]) / sumL;
  return out;
}

// Autocorrelation over 70–180 BPM in onset[start:end], gently biased toward ~120.
function autocorrBpm(onset, start, end, fps) {
  const minLag = Math.floor((60 * fps) / 180);
  const maxLag = Math.ceil((60 * fps) / 70);
  let bestLag = minLag;
  let bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let r = 0;
    for (let i = start; i + lag < end; i++) r += onset[i] * onset[i + lag];
    const bpm = (60 * fps) / lag;
    const bias = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.6, 2));
    r *= 0.6 + 0.4 * bias;
    if (r > bestScore) {
      bestScore = r;
      bestLag = lag;
    }
  }
  return (60 * fps) / bestLag;
}
