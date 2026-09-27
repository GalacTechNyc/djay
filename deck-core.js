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
    this.spinning = false; // free-spinning backwards (spinback effect)
    this.follow = false; // pointer drag: record chases the pointer's position
    this.target = 0;

    // A swipe stroke: the record travels a set distance with an ease-in /
    // ease-out curve, like a hand pushing vinyl.
    this.stroking = false;
    this.strokeDist = 0;
    this.strokeLen = 1;
    this.strokeT = 0;
    this.strokeDone = 0;

    // Slip: the track keeps running silently while the record is touched,
    // and playback rejoins it on release.
    this.slip = false;
    this.slipPos = 0;

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
        this.slipPos = 0;
        this.rate = 0;
        this.playing = false;
        this.held = false;
        this.spinning = false;
        this.follow = false;
        this.stroking = false;
        break;
      case 'play':
        this.playing = m.value;
        // Quantized start: full speed at once, no motor spin-up.
        if (m.value && m.instant && !this.held) this.rate = this.tempo;
        break;
      case 'tempo':
        this.tempo = m.value;
        break;
      case 'seek':
        this.pos = Math.max(0, Math.min(this.len - 1, m.value * this.bufRate));
        this.slipPos = this.pos;
        break;
      case 'slip':
        this.slip = m.value;
        this.slipPos = this.pos;
        break;
      case 'hold':
        this.held = m.value;
        this.spinning = false;
        this.follow = false;
        this.stroking = false;
        if (!m.value) {
          // Quantized release: back to full speed instantly so it lands on the beat.
          if (m.instant && this.playing) this.rate = this.tempo;
          this.rejoin();
        }
        break;
      case 'stroke':
        // m.dist seconds (negative = backwards) over m.dur seconds.
        this.held = true;
        this.spinning = false;
        this.follow = false;
        this.stroking = true;
        this.strokeDist = m.dist * this.bufRate;
        this.strokeLen = Math.max(1, Math.round(m.dur * this.sampleRate));
        this.strokeT = 0;
        this.strokeDone = 0;
        break;
      case 'follow':
        // Pointer on the record: chase its position (seconds into the track).
        this.held = true;
        this.spinning = false;
        this.stroking = false;
        this.follow = true;
        this.target = m.value * this.bufRate;
        break;
      case 'spinback':
        this.held = false;
        this.follow = false;
        this.stroking = false;
        this.rate = -m.value;
        this.spinning = true;
        break;
    }
  }

  // Letting go in slip mode: jump to where the track would be and play on at
  // full speed, so the beat never drifts.
  rejoin() {
    if (this.slip && this.playing) {
      this.pos = this.slipPos;
      this.rate = this.tempo;
    }
  }

  wrap(p) {
    if (p >= this.len) return this.loop ? p - this.len : this.len - 1;
    if (p < 0) return this.loop ? p + this.len : 0;
    return p;
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
      if (this.held && this.stroking) {
        // Raised-cosine position curve: zero speed at both ends, so strokes
        // start, stop and reverse without clicks.
        this.strokeT++;
        const x = this.strokeT >= this.strokeLen ? 1 : this.strokeT / this.strokeLen;
        const done = this.strokeDist * (0.5 - 0.5 * Math.cos(Math.PI * x));
        this.rate = (done - this.strokeDone) / this.srRatio;
        this.strokeDone = done;
        if (x >= 1) this.stroking = false;
      } else if (this.held && this.follow) {
        // Speed proportional to how far the record lags the pointer (closes
        // the gap in ~20 ms), so the record stops when the pointer stops.
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
        this.rate *= 0.98; // hand resting on the record
      } else if (this.spinning) {
        this.rate *= 0.99997;
        if (this.rate > -0.3) {
          this.spinning = false;
          this.rejoin();
        }
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
      if (this.pos >= len && !this.loop) {
        this.pos = len - 1;
        if (this.playing) ended = true;
        this.playing = false;
        this.rate = 0;
      } else {
        this.pos = this.wrap(this.pos);
      }

      // Slip: while the record is touched, a silent copy of the track keeps
      // playing; otherwise it just shadows the real position.
      if (this.slip && (this.held || this.spinning)) {
        if (this.playing) this.slipPos = this.wrap(this.slipPos + this.tempo * this.srRatio);
      } else {
        this.slipPos = this.pos;
      }
    }

    if (ended) this.emit({ type: 'ended' });
    if (++this.blocks % blocksPerReport === 0) {
      const slipping = this.slip && (this.held || this.spinning);
      this.emit({
        type: 'pos',
        pos: this.pos / this.bufRate,
        rate: this.rate,
        slipPos: slipping ? this.slipPos / this.bufRate : null,
      });
    }
  }
}
