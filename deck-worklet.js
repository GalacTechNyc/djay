import { DeckCore } from './deck-core.js';

// Audio-thread wrapper around the shared turntable engine.
class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.core = new DeckCore(sampleRate, (msg) => this.port.postMessage(msg));
    this.port.onmessage = (e) => this.core.onMessage(e.data);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    this.core.render(out[0], out[1] || out[0]);
    return true;
  }
}

registerProcessor('deck', DeckProcessor);
