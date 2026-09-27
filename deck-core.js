// Turntable-style playback engine, shared by the AudioWorklet (deck-worklet.js)
// and the ScriptProcessor fallback for browsers without AudioWorklet.
// Unlike AudioBufferSourceNode, this can play backwards and at any speed,
// which is what makes scratching possible.
export class DeckCore {
  // emit(msg) receives 'pos' / 'ended' reports.
  constructor(sampleRate, emit) {
    this.sampleRate = sampleRate;
    this.emit = emit;
    this.L = null;
    this.R = null;
    this.len = 0;
    this.bufRate = sampleRate;
    this.srRatio = 1;
    this.loop = false;

    this.pos = 0;        // position in buffer samples
    this.rate = 0;       // current platter speed (1 = normal, negative = backwards)
    this.playing = false;
    this.tempo = 1;

    this.held = false;   // "hand on the record"
    this.scratchVel = 0; // speed the hand is pushing the record
    this.strokeDecay = Math.exp(-1 / (0.09 * sampleRate));
    this.spinning = false; // free-spinning backwards (spinback effect)
    this.follow = false; // hand-position scratching
    this.target = 0;

    this.blocks = 0;
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.L = m.L;
        this.R = m.R || m.L;
        this.len = m.L.length;
        this.bufRate = m.sampleRate;
        this.srRatio = m.sampleRate / this.sampleRate;
        this.loop = !!m.loop;
        this.pos = 0;
        this.rate = 0;
        this.playing = false;
        this.held = false;
        this.scratchVel = 0;
        this.spinning = false;
        break;
      case 'play':
        this.playing = m.value;
        break;
      case 'tempo':
        this.tempo = m.value;
        break;
      case 'seek':
        this.pos = Math.max(0, Math.min(this.len - 1, m.value * this.bufRate));
        break;
      case 'hold':
        this.held = m.value;
        this.scratchVel = 0;
        this.spinning = false;
        this.follow = false;
        break;
      case 'stroke':
        // A discrete swipe: shove the record, then friction brings it to rest.
        this.held = true;
        this.spinning = false;
        this.follow = false;
        this.scratchVel = m.value;
        break;
      case 'drag':
        // Continuous drag: hand speed set directly.
        this.held = true;
        this.follow = false;
        this.scratchVel = m.value;
        break;
      case 'follow':
        // Hand on the record: chase the hand's position (seconds into the track).
        this.held = true;
        this.spinning = false;
        this.follow = true;
        this.target = m.value * this.bufRate;
        break;
      case 'spinback':
        this.held = false;
        this.rate = -m.value;
        this.spinning = true;
        break;
    }
  }

  // Fill one block of output. blocksPerReport controls how often position is reported.
  render(oL, oR, blocksPerReport = 6) {
    const n = oL.length;
    const L = this.L;
    if (!L) {
      oL.fill(0);
      if (oR !== oL) oR.fill(0);
      return;
    }
    const R = this.R;
    const len = this.len;
    let ended = false;

    for (let i = 0; i < n; i++) {
      if (this.held && this.follow) {
        // Speed proportional to how far the record lags the hand (closes the
        // gap in ~20 ms), so the record stops when the hand stops.
        let gap = this.target - this.pos;
        if (this.loop) {
          if (gap > len / 2) gap -= len;
          else if (gap < -len / 2) gap += len;
        }
        let want = gap / (this.bufRate * 0.02);
        if (want > 12) want = 12;
        else if (want < -12) want = -12;
        this.rate += (want - this.rate) * 0.05;
      } else if (this.held) {
        this.rate += (this.scratchVel - this.rate) * 0.02;
        this.scratchVel *= this.strokeDecay;
      } else if (this.spinning) {
        this.rate *= 0.99997;
        if (this.rate > -0.3) this.spinning = false;
      } else {
        const target = this.playing ? this.tempo : 0;
        // Motor start is quick, brake is a touch slower — like a real deck.
        this.rate += (target - this.rate) * (this.playing ? 0.0006 : 0.0002);
      }

      const i0 = this.pos | 0;
      const f = this.pos - i0;
      let i1 = i0 + 1;
      if (i1 >= len) i1 = this.loop ? 0 : i0;
      oL[i] = L[i0] + (L[i1] - L[i0]) * f;
      oR[i] = R[i0] + (R[i1] - R[i0]) * f;

      this.pos += this.rate * this.srRatio;
      if (this.pos >= len) {
        if (this.loop) this.pos -= len;
        else {
          this.pos = len - 1;
          if (this.playing) ended = true;
          this.playing = false;
          this.rate = 0;
        }
      } else if (this.pos < 0) {
        this.pos = this.loop ? this.pos + len : 0;
      }
    }

    if (ended) this.emit({ type: 'ended' });
    if (++this.blocks % blocksPerReport === 0) {
      this.emit({ type: 'pos', pos: this.pos / this.bufRate, rate: this.rate });
    }
  }
}
