// Turntable-style playback engine. Runs on the audio thread.
// Unlike AudioBufferSourceNode, this can play backwards and at any speed,
// which is what makes scratching possible.
class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
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

    this.blocks = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.L = m.L;
        this.R = m.R || m.L;
        this.len = m.L.length;
        this.bufRate = m.sampleRate;
        this.srRatio = m.sampleRate / sampleRate;
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
        break;
      case 'stroke':
        // A discrete swipe: shove the record, then friction brings it to rest.
        this.held = true;
        this.spinning = false;
        this.scratchVel = m.value;
        break;
      case 'drag':
        // Continuous drag: hand speed set directly.
        this.held = true;
        this.scratchVel = m.value;
        break;
      case 'spinback':
        this.held = false;
        this.rate = -m.value;
        this.spinning = true;
        break;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0];
    const oR = out[1] || out[0];
    const n = oL.length;
    const L = this.L;
    if (!L) {
      oL.fill(0);
      if (oR !== oL) oR.fill(0);
      return true;
    }
    const R = this.R;
    const len = this.len;
    let ended = false;

    for (let i = 0; i < n; i++) {
      if (this.held) {
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

    if (ended) this.port.postMessage({ type: 'ended' });
    if (++this.blocks % 6 === 0) {
      this.port.postMessage({ type: 'pos', pos: this.pos / this.bufRate, rate: this.rate });
    }
    return true;
  }
}

registerProcessor('deck', DeckProcessor);
