import { DEMOS, renderDemo } from './synth.js';
import { DeckCore } from './deck-core.js';
import { computePeaks, detectTempo, PEAKS_PER_SEC } from './analyze.js';
import {
  searchAppleMusic,
  appleMusicTopSongs,
  searchAudius,
  audiusTrending,
  archiveReleases,
  jamendoEnabled,
  jamendoPopular,
  searchJamendo,
} from './music.js';

const $ = (s) => document.querySelector(s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const COLORS = ['#22d3ee', '#ff4fd8'];
const TEMPO_RANGE = 0.16;
// Mouse/touch platter dragging: how far the record moves per pixel.
const SECONDS_PER_PX = 1 / 400;

// Clean up settings from the removed Hand scratch mode.
try {
  localStorage.removeItem('djay.drag');
  localStorage.removeItem('djay.sens');
} catch {}

// ---------- state ----------

const state = {
  xf: 0.5,
  cut: [false, false],
  engaged: null,
  automix: null,
  audioReady: null,
  toastUntil: 0,
  quantize: false,
  page: 'deck',
  tilt: null, // head-tilt filter: { deck, base, value }
};

const decks = [0, 1].map((i) => ({
  i,
  name: 'AB'[i],
  el: {
    title: $(`#title${'AB'[i]}`),
    meta: $(`#meta${'AB'[i]}`),
    wave: $(`#wave${'AB'[i]}`),
    platter: $(`#plat${'AB'[i]}`),
    disc: $(`#plat${'AB'[i]} .disc`),
    play: $(`[data-action="play"][data-deck="${i}"]`),
    sync: $(`[data-action="sync"][data-deck="${i}"]`),
    slip: $(`[data-action="slip"][data-deck="${i}"]`),
  },
  node: null,
  filter: null,
  xfGain: null,
  track: null,
  bpm: 0,
  offset: 0,
  duration: 0,
  pos: 0,
  posAt: 0,
  rate: 0,
  playing: false,
  tempo: 1,
  filterVal: 0,
  cue: 0,
  peaks: null,
  sync: false,
  slip: false,
  slipPos: null,
  eq: { low: 0, mid: 0, high: 0 },
  kill: { low: false, mid: false, high: false },
  autoLowCut: false, // bass swap during Automix
  loopOn: false,
  loopStart: 0,
  loopSize: 4, // beats
  taps: [],
  held: false,
  loading: false,
}));

let ctx, master;
const demoCache = new Map();

// ---------- audio ----------

function ensureAudio() {
  if (!state.audioReady) {
    state.audioReady = initAudio().catch((err) => {
      state.audioReady = null; // let the next press retry
      throw err;
    });
  }
  if (ctx && ctx.state === 'suspended') ctx.resume();
  return state.audioReady;
}

async function initAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('This browser has no Web Audio support');
  ctx = ctx || new AC({ latencyHint: 'interactive' });
  let useWorklet = !!(ctx.audioWorklet && window.AudioWorkletNode) && !/[?&]engine=fallback/.test(location.search);
  if (useWorklet) {
    try {
      await ctx.audioWorklet.addModule('deck-worklet.js');
    } catch (err) {
      console.warn('AudioWorklet failed, using fallback engine', err);
      useWorklet = false;
    }
  }
  state.engine = useWorklet ? 'AudioWorklet' : 'ScriptProcessor (fallback)';

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  master = ctx.createGain();
  master.gain.value = 0.9;
  // Soft clipper after the limiter: peaks that slip past it are rounded off
  // instead of hard-clipping into crackles.
  const soft = ctx.createWaveShaper();
  const curve = new Float32Array(2048);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.abs(x) < 0.8 ? x : Math.sign(x) * (0.8 + 0.2 * Math.tanh((Math.abs(x) - 0.8) / 0.2));
  }
  soft.curve = curve;
  soft.oversample = '2x';
  master.connect(limiter);
  limiter.connect(soft);
  soft.connect(ctx.destination);
  for (const d of decks) {
    d.node = useWorklet ? makeWorkletDeck() : makeScriptDeck();
    d.eqNodes = {
      low: Object.assign(ctx.createBiquadFilter(), { type: 'lowshelf' }),
      mid: Object.assign(ctx.createBiquadFilter(), { type: 'peaking' }),
      high: Object.assign(ctx.createBiquadFilter(), { type: 'highshelf' }),
    };
    d.eqNodes.low.frequency.value = 250;
    d.eqNodes.mid.frequency.value = 1000;
    d.eqNodes.mid.Q.value = 0.8;
    d.eqNodes.high.frequency.value = 4000;
    // Kill switches: a steep filter on top of the shelf, so a kill really removes the band.
    d.killNodes = {
      low: Object.assign(ctx.createBiquadFilter(), { type: 'highpass' }),
      high: Object.assign(ctx.createBiquadFilter(), { type: 'lowpass' }),
    };
    d.killNodes.low.frequency.value = 10;
    d.killNodes.high.frequency.value = 22000;
    d.filter = ctx.createBiquadFilter();
    d.xfGain = ctx.createGain();
    d.node.connect(d.eqNodes.low);
    d.eqNodes.low.connect(d.eqNodes.mid);
    d.eqNodes.mid.connect(d.eqNodes.high);
    d.eqNodes.high.connect(d.killNodes.low);
    d.killNodes.low.connect(d.killNodes.high);
    d.killNodes.high.connect(d.filter);
    d.filter.connect(d.xfGain);
    d.xfGain.connect(master);
    d.node.port.onmessage = (e) => onDeckMessage(d, e.data);
    applyFilter(d);
  }
  applyXf(true);
}

function makeWorkletDeck() {
  return new AudioWorkletNode(ctx, 'deck', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
}

// Same engine on the main thread, for browsers without AudioWorklet.
function makeScriptDeck() {
  const node = ctx.createScriptProcessor(1024, 0, 2);
  const port = { onmessage: null, postMessage: (msg) => core.onMessage(msg) };
  const core = new DeckCore(ctx.sampleRate, (msg) => port.onmessage?.({ data: msg }));
  node.onaudioprocess = (e) => {
    const out = e.outputBuffer;
    core.render(out.getChannelData(0), out.getChannelData(1), 1);
  };
  node.port = port;
  return node;
}

const post = (d, msg, transfer) => {
  // Keep our position estimate in step immediately; the engine confirms ~16 ms later.
  if (msg.type === 'seek') {
    d.pos = msg.value;
    d.posAt = performance.now();
  }
  d.node?.port.postMessage(msg, transfer || []);
};

function onDeckMessage(d, m) {
  if (m.type === 'pos') {
    d.pos = m.pos;
    d.rate = m.rate;
    d.slipPos = m.slipPos;
    d.posAt = performance.now();
  } else if (m.type === 'ended') {
    d.playing = false;
    renderButtons();
  }
}

const estPos = (d) => d.pos + (d.rate * (performance.now() - d.posAt)) / 1000;

function applyFilter(d) {
  if (!d.filter) return;
  const v = d.filterVal;
  const f = d.filter;
  const t = ctx.currentTime;
  if (Math.abs(v) < 0.02) {
    f.type = 'lowpass';
    f.frequency.setTargetAtTime(20000, t, 0.02);
    f.Q.setTargetAtTime(0.7, t, 0.02);
  } else if (v < 0) {
    f.type = 'lowpass';
    f.frequency.setTargetAtTime(20000 * Math.pow(200 / 20000, -v), t, 0.02);
    f.Q.setTargetAtTime(0.7 + -v * 5, t, 0.02);
  } else {
    f.type = 'highpass';
    f.frequency.setTargetAtTime(20 * Math.pow(6000 / 20, v), t, 0.02);
    f.Q.setTargetAtTime(0.7 + v * 5, t, 0.02);
  }
}

// Constant-power crossfade: each deck is at ~70% in the middle, so a blend is
// as loud as a single track (full + full would jump ~3–6 dB and clip).
function applyXf(instant = false) {
  if (!ctx) return;
  const x = state.xf;
  const g = [Math.cos((x * Math.PI) / 2), Math.sin((x * Math.PI) / 2)];
  decks.forEach((d, i) => {
    const v = state.cut[i] ? 0 : g[i];
    d.xfGain.gain.setTargetAtTime(v, ctx.currentTime, instant ? 0.003 : 0.015);
  });
}

// ---------- EQ ----------
// Slider value -1..1: -1 = kill, below 0 cuts up to -24 dB, above 0 boosts up to +6 dB.
const eqDb = (v) => (v <= -0.99 ? -40 : v < 0 ? v * 24 : v * 6);

function applyEq(d, tc = 0.03) {
  if (!d.eqNodes) return;
  for (const band of ['low', 'mid', 'high']) {
    const killed = d.kill[band] || (band === 'low' && d.autoLowCut) || d.eq[band] <= -0.99;
    d.eqNodes[band].gain.setTargetAtTime(killed ? -40 : eqDb(d.eq[band]), ctx.currentTime, tc);
    if (d.killNodes[band]) {
      const hz = band === 'low' ? (killed ? 300 : 10) : killed ? 2500 : 22000;
      d.killNodes[band].frequency.setTargetAtTime(hz, ctx.currentTime, tc);
    }
  }
}

function toggleKill(d, band) {
  d.kill[band] = !d.kill[band];
  applyEq(d, 0.008);
  renderButtons();
}

// ---------- loading ----------

async function loadTrack(d, item) {
  try {
    await ensureAudio();
  } catch (err) {
    return reportError('Audio engine failed', err);
  }
  if (d.loading) return;
  d.loading = true;
  d.playing = false;
  d.sync = false;
  post(d, { type: 'play', value: false });
  d.el.title.textContent = 'Loading…';
  d.el.meta.textContent = item.title;
  renderButtons();
  try {
    let buf;
    if (item.style) {
      buf = demoCache.get(item.id);
      if (!buf) {
        buf = await renderDemo(item);
        demoCache.set(item.id, buf);
      }
    } else {
      const src = item.file
        ? item.file
        : await fetchAudio(item.urls || [item.url], (got, total) => {
            const mb = (got / 1e6).toFixed(1);
            d.el.title.textContent = total ? `Loading… ${Math.round((got / total) * 100)}%` : `Loading… ${mb} MB`;
          });
      d.el.title.textContent = 'Analyzing…';
      const ab = src instanceof ArrayBuffer ? src : await src.arrayBuffer();
      buf = await new Promise((resolve, reject) => {
        const p = ctx.decodeAudioData(ab, resolve, (e) => reject(e || new Error('Audio format not supported')));
        p?.catch?.(reject);
      });
    }
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    d.peaks = computePeaks(L, R, buf.sampleRate);
    const grid = item.style ? { bpm: item.bpm, offset: 0 } : detectTempo(L, buf.sampleRate, item.bpm);
    d.bpm = grid.bpm;
    d.offset = grid.offset;
    d.duration = buf.duration;
    d.cue = d.offset;
    d.track = item;
    d.tempo = 1;
    d.loopOn = false;
    d.taps = [];
    d.pos = d.cue;
    d.rate = 0;
    const Lc = L.slice();
    const Rc = R === L ? null : R.slice();
    post(d, { type: 'load', L: Lc, R: Rc, sampleRate: buf.sampleRate, loop: !!item.loop }, Rc ? [Lc.buffer, Rc.buffer] : [Lc.buffer]);
    post(d, { type: 'tempo', value: 1 });
    post(d, { type: 'seek', value: d.cue });
    post(d, { type: 'slip', value: d.slip });
    showArt(d, item);
    toast(`${d.name} ← ${item.title}`);
  } catch (err) {
    reportError(`Couldn't load ${item.title}`, err);
    d.track = null;
  } finally {
    d.loading = false;
    renderDeckText(d);
    renderButtons();
    renderSliders(); // tempo resets to 0% for the new track
  }
}

// Try each URL in turn. A download only fails if it can't connect or stops
// receiving data — slow-but-steady connections are fine.
// Album art on the platter, trying mirror URLs if the first one fails.
function showArt(d, item) {
  const urls = [item.art, ...(item.artAlts || [])].filter(Boolean);
  d.el.disc.style.backgroundImage = '';
  d.el.platter.classList.remove('has-art');
  const tryNext = (i) => {
    if (i >= urls.length || d.track !== item) return;
    const img = new Image();
    img.onload = () => {
      if (d.track !== item) return;
      d.el.disc.style.backgroundImage = `url("${urls[i]}")`;
      d.el.platter.classList.add('has-art');
    };
    img.onerror = () => tryNext(i + 1);
    img.src = urls[i];
  };
  tryNext(0);
}

async function fetchAudio(urls, onProgress) {
  let lastErr;
  for (const url of urls) {
    try {
      return await fetchOne(url, onProgress);
    } catch (err) {
      lastErr = err;
      console.warn('Download failed, trying next source', url, err);
    }
  }
  throw lastErr || new Error('no audio source');
}

async function fetchOne(url, onProgress) {
  const ctl = new AbortController();
  let timer;
  let why = 'connect';
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(), ms);
  };
  try {
    arm(10000);
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    const total = +res.headers.get('content-length') || 0;
    if (!res.body?.getReader) return await res.arrayBuffer();
    why = 'stall';
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    arm(15000);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      arm(15000);
      onProgress?.(got, total);
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out.buffer;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(why === 'connect' ? "server didn't respond" : 'download stalled');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- transport ----------

async function togglePlay(d) {
  try {
    await ensureAudio();
  } catch (err) {
    return reportError('Audio engine failed', err);
  }
  if (!d.track) return openLibrary(d.i);
  d.playing = !d.playing;
  if (d.playing && state.quantize) {
    // Start in step with the other deck, or on this track's nearest beat.
    const lead = decks[1 - d.i];
    if (lead.playing && lead.track) alignPhase(d, lead);
    else post(d, { type: 'seek', value: snapToBeat(d, estPos(d)) });
  }
  post(d, { type: 'play', value: d.playing, instant: d.playing && state.quantize });
  renderButtons();
}

function snapToBeat(d, t) {
  const beat = 60 / d.bpm;
  return Math.max(0, d.offset + Math.round((t - d.offset) / beat) * beat);
}

function toggleQuantize() {
  state.quantize = !state.quantize;
  toast(state.quantize ? 'Quantize on — play, cue and scratch snap to the beat' : 'Quantize off');
  renderButtons();
}

// CUE: set the cue point right here, playing or paused.
function cue(d) {
  if (!d.track) return;
  d.cue = state.quantize ? snapToBeat(d, estPos(d)) : estPos(d);
  toast(`${d.name}: cue set at ${fmt(d.cue)}${state.quantize ? ' (on beat)' : ''}`);
}

// Jump within the track, keeping play/pause as is. With quantize on and the
// deck playing, the jump keeps the current position within the beat so the
// mix stays in time.
function jumpTo(d, t) {
  if (!d.track) return;
  if (state.quantize && d.playing) {
    const beat = 60 / d.bpm;
    const within = (((estPos(d) - d.offset) % beat) + beat) % beat;
    t = snapToBeat(d, t) + within;
    while (t < 0) t += beat;
  }
  post(d, { type: 'seek', value: Math.max(0, t) });
}

// ↩ hot cue: jump to the cue point.
function hotCue(d) {
  if (!d.track) return;
  jumpTo(d, d.cue);
  toast(`${d.name}: ↩ cue ${fmt(d.cue)}`);
}

// ⏮ back to the beginning of the track.
function toStart(d) {
  if (!d.track) return;
  jumpTo(d, 0);
  toast(`${d.name}: ⏮ start`);
}

function setTempo(d, t) {
  d.tempo = clamp(t, 0.5, 1.5);
  post(d, { type: 'tempo', value: d.tempo });
  const other = decks[1 - d.i];
  if (other.sync && other.track && d.track) matchTempo(other, d);
  renderDeckText(d);
}

function matchTempo(d, lead) {
  let r = (lead.bpm * lead.tempo) / d.bpm;
  while (r > 1.41) r /= 2;
  while (r < 0.71) r *= 2;
  d.tempo = r;
  post(d, { type: 'tempo', value: r });
  renderDeckText(d);
}

function alignPhase(d, lead) {
  const bl = 60 / lead.bpm;
  const bd = 60 / d.bpm;
  const phase = ((((estPos(lead) - lead.offset) / bl) % 1) + 1) % 1;
  const pos = estPos(d);
  let target = d.offset + (Math.floor((pos - d.offset) / bd) + phase) * bd;
  if (target - pos > bd / 2) target -= bd;
  if (pos - target > bd / 2) target += bd;
  // At the very start of a track the matching spot can fall before 0:00;
  // go one beat later instead of clamping (clamping lands off the beat).
  while (target < 0) target += bd;
  post(d, { type: 'seek', value: target });
}

// Slip: scratch, spin back or hold the record while the track keeps running
// silently underneath; letting go picks up right on the beat.
function toggleSlip(d) {
  d.slip = !d.slip;
  post(d, { type: 'slip', value: d.slip });
  toast(`${d.name} slip ${d.slip ? 'on — scratch without losing the beat' : 'off'}`);
  renderButtons();
}

function toggleSync(d) {
  const lead = decks[1 - d.i];
  if (!d.track || !lead.track) return toast('Load both decks to sync');
  d.sync = !d.sync;
  if (d.sync) {
    lead.sync = false;
    matchTempo(d, lead);
    alignPhase(d, lead);
    toast(`${d.name} synced → ${(d.bpm * d.tempo).toFixed(1)} BPM`);
  } else toast(`${d.name} sync off`);
  renderButtons();
}

// ---------- loops & beat jump ----------

const beatSecs = (d) => 60 / d.bpm; // one beat, in track time
const fmtBeats = (b) => ({ 0.25: '¼', 0.5: '½' })[b] || String(b);

function setLoop(d) {
  post(d, { type: 'loop', on: d.loopOn, start: d.loopStart, len: d.loopSize * beatSecs(d) });
}

function toggleLoop(d) {
  if (!d.track) return;
  d.loopOn = !d.loopOn;
  if (d.loopOn) {
    const pos = estPos(d);
    const b = beatSecs(d);
    // Quantize: start on the beat just played, so the loop is in time.
    d.loopStart = state.quantize ? Math.max(0, d.offset + Math.floor((pos - d.offset) / b) * b) : pos;
  }
  setLoop(d);
  toast(d.loopOn ? `${d.name}: loop ${fmtBeats(d.loopSize)} beat${d.loopSize > 1 ? 's' : ''}` : `${d.name}: loop off`);
  renderButtons();
}

function resizeLoop(d, factor) {
  d.loopSize = clamp(d.loopSize * factor, 0.25, 32);
  if (d.loopOn) setLoop(d);
  toast(`${d.name}: loop / jump size ${fmtBeats(d.loopSize)}`);
  renderButtons();
}

function beatJump(d, dir) {
  if (!d.track) return;
  const dist = dir * Math.max(1, d.loopSize) * beatSecs(d);
  if (d.loopOn) {
    d.loopStart = Math.max(0, d.loopStart + dist);
    setLoop(d);
  }
  // Already a whole number of beats, so no quantize rounding (that could
  // land a beat short when mid-beat).
  let t = estPos(d) + dist;
  if (d.track.loop) t = ((t % d.duration) + d.duration) % d.duration; // looping demos wrap
  else while (t < 0) t += beatSecs(d); // near the start: earliest spot still on the beat
  post(d, { type: 'seek', value: t });
  toast(`${d.name}: jump ${dir > 0 ? '+' : '−'}${Math.max(1, d.loopSize)} beats`);
}

// ---------- tempo tools ----------

function scaleBpm(d, factor) {
  if (!d.track) return;
  const bpm = d.bpm * factor;
  if (bpm < 40 || bpm > 300) return toast(`${d.name}: ${bpm.toFixed(0)} BPM is out of range`);
  d.bpm = bpm;
  afterBpmChange(d);
  toast(`${d.name}: ${(d.bpm * d.tempo).toFixed(1)} BPM`);
}

// Tap along with the beat: 4+ taps set the tempo, and the last tap marks a beat.
function tapTempo(d) {
  if (!d.track) return;
  const now = performance.now();
  if (d.taps.length && now - d.taps[d.taps.length - 1] > 2000) d.taps = [];
  d.taps.push(now);
  if (d.taps.length > 8) d.taps.shift();
  if (d.taps.length < 4) return toast(`${d.name}: tap ${d.taps.length}… keep tapping on the beat`);
  const avg = (d.taps[d.taps.length - 1] - d.taps[0]) / (d.taps.length - 1);
  const heard = 60000 / avg; // BPM as heard (includes the tempo slider)
  const bpm = heard / (d.playing ? d.tempo : 1);
  if (bpm < 50 || bpm > 220) return toast(`${d.name}: tap steadier`);
  d.bpm = Math.round(bpm * 10) / 10;
  const b = beatSecs(d);
  const pos = estPos(d);
  d.offset = pos - Math.floor(pos / b) * b;
  afterBpmChange(d);
  toast(`${d.name}: tapped ${(d.bpm * d.tempo).toFixed(1)} BPM`);
}

function afterBpmChange(d) {
  const other = decks[1 - d.i];
  if (d.sync && other.track) matchTempo(d, other);
  else if (other.sync && other.track) matchTempo(other, d);
  if (d.loopOn) setLoop(d);
  renderDeckText(d);
}

// ---------- pages ----------

const PAGES = ['deck', 'loop', 'eq'];
function nextPage() {
  state.page = PAGES[(PAGES.indexOf(state.page) + 1) % PAGES.length];
  for (const el of document.querySelectorAll('.page')) el.hidden = el.dataset.page !== state.page;
  $('#pageName').textContent = { deck: 'Deck', loop: 'Loop', eq: 'EQ' }[state.page];
  toast(`Controls: ${{ deck: 'Deck', loop: 'Loops & tempo', eq: 'EQ' }[state.page]}`);
}

// ---------- head-tilt filter (experimental) ----------
// Tilt your head left/right to sweep the filter on the deck you're hearing.

function liveDeck() {
  return state.xf <= 0.5 ? decks[0] : decks[1];
}

function onTilt(e) {
  const t = state.tilt;
  if (!t || e.gamma == null) return;
  if (t.base == null) t.base = e.gamma; // wherever your head is when it starts = neutral
  let v = (e.gamma - t.base) / 30;
  v = Math.abs(v) < 0.25 ? 0 : clamp((v - Math.sign(v) * 0.25) / 0.75, -1, 1); // dead zone
  t.value += (v - t.value) * 0.3;
  const d = liveDeck();
  if (t.deck && t.deck !== d) {
    t.deck.filterVal = 0;
    applyFilter(t.deck);
  }
  t.deck = d;
  d.filterVal = Math.abs(t.value) < 0.05 ? 0 : t.value;
  applyFilter(d);
  t.seen = true;
}

async function toggleTilt(row) {
  if (state.tilt) {
    window.removeEventListener('deviceorientation', onTilt);
    if (state.tilt.deck) {
      state.tilt.deck.filterVal = 0;
      applyFilter(state.tilt.deck);
    }
    state.tilt = null;
    toast('Head-tilt filter off');
  } else {
    try {
      if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') return toast('Motion sensor permission denied');
      }
    } catch (err) {
      return reportError('Motion sensor', err);
    }
    state.tilt = { deck: null, base: null, value: 0, seen: false };
    window.addEventListener('deviceorientation', onTilt);
    toast('Head-tilt filter on — tilt left = low-pass, right = high-pass');
    setTimeout(() => {
      if (state.tilt && !state.tilt.seen) toast('No motion sensor data from this device');
    }, 2500);
  }
  if (row) {
    row.value = state.tilt ? 'ON' : 'OFF';
    row.on = !!state.tilt;
    renderLibrary();
  }
}

// ---------- automix ----------

async function toggleAutomix() {
  await ensureAudio();
  if (state.automix) {
    for (const d of decks) d.autoLowCut = false;
    for (const d of decks) applyEq(d);
    state.automix = null;
    renderButtons();
    return toast('Automix cancelled');
  }
  const live = state.xf <= 0.5 ? decks[0] : decks[1];
  const from = live.playing ? live : decks.find((d) => d.playing) || live;
  const to = decks[1 - from.i];

  if (!from.track) await loadTrack(from, library.home.find((r) => r.kind === 'track').item);
  if (!from.playing) {
    await togglePlay(from);
    state.xf = from.i ? 1 : 0;
    applyXf();
    renderSliders();
    return toast(`Playing deck ${from.name} — hit Automix again to mix`);
  }
  if (!to.track || to.track === from.track) await loadTrack(to, nextTrack(from.track));
  if (!to.track) return;

  to.filterVal = 0;
  applyFilter(to);
  // Bass swap: the incoming deck's bass stays out until halfway through.
  to.autoLowCut = true;
  applyEq(to, 0.01);
  matchTempo(to, from);
  alignPhase(to, from);
  to.playing = true;
  // Full speed at once (no motor spin-up), so the blend lands on the beat.
  post(to, { type: 'play', value: true, instant: true });

  const beats = 16;
  state.automix = {
    from,
    to,
    t0: ctx.currentTime,
    dur: (beats * 60) / (from.bpm * from.tempo),
    xf0: state.xf,
    xf1: to.i ? 1 : 0,
  };
  toast(`Automix ${from.name} → ${to.name} over ${beats} beats`);
  renderButtons();
}

function stepAutomix() {
  const m = state.automix;
  if (!m) return;
  const p = clamp((ctx.currentTime - m.t0) / m.dur, 0, 1);
  const e = p * p * (3 - 2 * p);
  state.xf = m.xf0 + (m.xf1 - m.xf0) * e;
  applyXf();
  if (p >= 0.5 && !m.swapped) {
    // Swap basslines so the two kick drums never play together.
    m.swapped = true;
    m.from.autoLowCut = true;
    m.to.autoLowCut = false;
    applyEq(m.from, 0.04);
    applyEq(m.to, 0.04);
  }
  m.from.filterVal = p > 0.6 ? ((p - 0.6) / 0.4) * 0.5 : 0;
  applyFilter(m.from);
  if (p >= 1) {
    m.from.playing = false;
    post(m.from, { type: 'play', value: false });
    m.from.filterVal = 0;
    m.from.autoLowCut = false;
    applyFilter(m.from);
    applyEq(m.from);
    state.automix = null;
    renderButtons();
  }
  renderSliders();
}

function nextTrack(current) {
  const tracks = library.rows.filter((r) => r.kind === 'track').map((r) => r.item);
  const pool = tracks.length ? tracks : DEMOS;
  const i = pool.findIndex((t) => t.id === current?.id);
  return pool[(i + 1) % pool.length];
}

// ---------- scratching ----------

function grab(d) {
  d.held = true;
  post(d, { type: 'hold', value: true });
  d.el.platter.classList.add('held');
}

function release(d) {
  d.held = false;
  d.el.platter.classList.remove('held');
  // Quantize (without slip): let go right in step with the other deck.
  const lead = decks[1 - d.i];
  const snap = state.quantize && !d.slip && d.playing && lead.playing && lead.track;
  post(d, { type: 'hold', value: false, instant: snap });
  if (snap) alignPhase(d, lead);
}

// One swipe = the record travels 0.25 s with an ease-in/ease-out curve, like
// a hand pushing vinyl (about 2.5x speed at the middle of the stroke).
const STROKE = { dist: 0.25, dur: 0.16 };
function stroke(d, dir) {
  post(d, { type: 'stroke', dist: dir * STROKE.dist, dur: STROKE.dur });
  d.el.platter.classList.remove('flick-l', 'flick-r');
  void d.el.platter.offsetWidth;
  d.el.platter.classList.add(dir > 0 ? 'flick-r' : 'flick-l');
}

// ---------- sliders ----------

const eqSlider = (band) => ({
  get: (d) => d.eq[band],
  set: (v, d) => {
    d.eq[band] = Math.abs(v) < 0.05 ? 0 : clamp(v, -1, 1);
    applyEq(d);
  },
  step: 0.125,
  norm: (v) => (v + 1) / 2,
  label: (v) => (v <= -0.99 ? 'KILL' : `${v > 0 ? '+' : ''}${Math.round(eqDb(v))}dB`),
});

const SLIDERS = {
  eqLow: eqSlider('low'),
  eqMid: eqSlider('mid'),
  eqHigh: eqSlider('high'),
  xf: {
    get: () => state.xf,
    set: (v) => {
      state.xf = clamp(v, 0, 1);
      if (state.automix) state.automix = null;
      applyXf();
    },
    step: 0.1,
    norm: (v) => v,
    label: (v) => (v < 0.05 ? 'A' : v > 0.95 ? 'B' : `${Math.round((1 - v) * 100)}:${Math.round(v * 100)}`),
  },
  tempo: {
    get: (d) => d.tempo,
    set: (v, d) => {
      d.sync = false;
      setTempo(d, v);
    },
    step: 0.01,
    fine: 0.001,
    norm: (v) => clamp((v - 1) / (2 * TEMPO_RANGE) + 0.5, 0, 1),
    label: (v) => `${v >= 1 ? '+' : ''}${((v - 1) * 100).toFixed(1)}%`,
  },
  filter: {
    get: (d) => d.filterVal,
    set: (v, d) => {
      d.filterVal = Math.abs(v) < 0.05 ? 0 : clamp(v, -1, 1);
      applyFilter(d);
    },
    step: 0.1,
    norm: (v) => (v + 1) / 2,
    label: (v) => (v === 0 ? 'OFF' : v < 0 ? `LP ${Math.round(-v * 100)}` : `HP ${Math.round(v * 100)}`),
  },
};

function nudgeSlider(el, dir, fine) {
  const s = SLIDERS[el.dataset.param];
  const d = decks[+el.dataset.deck]; // undefined for the crossfader
  const step = fine && s.fine ? s.fine : s.step;
  s.set(s.get(d) + dir * step, d);
  renderSliders();
  renderButtons();
}

// ---------- UI rendering ----------

const fmt = (t) => {
  t = Math.max(0, t);
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
};

function renderDeckText(d) {
  if (d.loading) return;
  if (!d.track) {
    d.el.title.textContent = `Deck ${d.name} — empty`;
    d.el.meta.textContent = 'Open Library to load';
    return;
  }
  d.el.title.textContent = d.track.title;
  const bpm = (d.bpm * d.tempo).toFixed(1);
  const tag = d.track.preview ? ' · 0:30 preview' : d.track.license ? ` · ${d.track.license}` : '';
  d.el.meta.dataset.base = `${d.track.artist || ''}${tag}`;
  d.el.meta.dataset.bpm = bpm;
}

function renderMeta(d, pos) {
  if (!d.track || d.loading) return;
  const left = d.track.loop ? '∞' : `-${fmt(d.duration - pos)}`;
  d.el.meta.textContent = `${d.el.meta.dataset.bpm} BPM · ${left} · ${d.el.meta.dataset.base}`;
}

function renderButtons() {
  for (const d of decks) {
    d.el.play.textContent = d.playing ? '❚❚' : '▶';
    d.el.play.classList.toggle('on', d.playing);
    d.el.sync.classList.toggle('on', d.sync);
    d.el.slip.classList.toggle('on', d.slip);
    for (const b of document.querySelectorAll(`[data-action="kill"][data-deck="${d.i}"]`)) b.classList.toggle('kill-on', d.kill[b.dataset.band]);
    const loopBtn = $(`[data-action="loop"][data-deck="${d.i}"]`);
    loopBtn.textContent = `LOOP ${fmtBeats(d.loopSize)}`;
    loopBtn.classList.toggle('on', d.loopOn);
  }
  $('[data-action="automix"]').classList.toggle('on', !!state.automix);
  $('[data-action="quantize"]').classList.toggle('on', state.quantize);
}

function renderSliders() {
  for (const el of document.querySelectorAll('.slider')) {
    const s = SLIDERS[el.dataset.param];
    const d = decks[+el.dataset.deck];
    const v = s.get(d);
    el.querySelector('.thumb').style.left = `${s.norm(v) * 100}%`;
    el.querySelector('.val').textContent = s.label(v);
  }
}

function drawWave(d, pos) {
  const c = d.el.wave;
  const g = c.getContext('2d');
  const W = c.width;
  const H = c.height;
  g.clearRect(0, 0, W, H);
  if (!d.peaks) return;
  const span = 6;
  const start = pos - span / 2;
  const n = d.peaks.length;
  const loop = d.track?.loop;
  if (d.loopOn) {
    // Loop region
    const x0 = ((d.loopStart - start) / span) * W;
    const x1 = ((d.loopStart + d.loopSize * (60 / d.bpm) - start) / span) * W;
    g.fillStyle = 'rgba(255, 210, 63, 0.22)';
    g.fillRect(Math.max(0, x0), 0, Math.min(W, x1) - Math.max(0, x0), H);
  }
  g.fillStyle = COLORS[d.i];
  for (let x = 0; x < W; x++) {
    const i0 = Math.floor((start + (x / W) * span) * PEAKS_PER_SEC);
    const i1 = Math.floor((start + ((x + 1) / W) * span) * PEAKS_PER_SEC);
    let m = 0;
    for (let i = i0; i <= i1; i++) {
      let k = i;
      if (loop) k = ((i % n) + n) % n;
      else if (i < 0 || i >= n) continue;
      if (d.peaks[k] > m) m = d.peaks[k];
    }
    const h = Math.max(1, m * H * 0.9);
    g.fillRect(x, (H - h) / 2, 1, h);
  }
  // beat grid
  const beat = 60 / d.bpm;
  g.fillStyle = '#ffffff';
  for (let k = Math.ceil((start - d.offset) / beat); d.offset + k * beat < start + span; k++) {
    const x = ((d.offset + k * beat - start) / span) * W;
    const bar = ((k % 4) + 4) % 4 === 0;
    g.fillRect(x, 0, bar ? 2 : 1, bar ? 8 : 4);
  }
  g.fillStyle = '#ffffff';
  g.fillRect(W / 2 - 1, 0, 2, H);
  // Slip: where the silent track is while the record is being scratched.
  if (d.slipPos != null) {
    let off = d.slipPos - pos;
    if (loop && d.duration) off -= Math.round(off / d.duration) * d.duration;
    const x = W / 2 + (off / span) * W;
    if (x >= 0 && x <= W) {
      g.fillStyle = 'rgba(255, 210, 63, 0.85)';
      g.fillRect(x - 1, 0, 2, H);
    }
  }
}

let lastFrame = 0;
function frame(t) {
  requestAnimationFrame(frame);
  if (t - lastFrame < 32) return; // display runs at 30 Hz
  lastFrame = t;
  if (ctx) stepAutomix();
  for (const d of decks) {
    const pos = d.track ? estPos(d) : 0;
    d.el.disc.style.transform = `rotate(${(pos * 200) % 360}deg)`;
    renderMeta(d, pos);
    drawWave(d, pos);
  }
  if (performance.now() > state.toastUntil) renderHint();
}

// ---------- hints / toasts ----------

const hintEl = $('#hint');
function toast(msg, ms = 1800) {
  hintEl.textContent = msg;
  hintEl.classList.add('toast');
  state.toastUntil = performance.now() + ms;
}

function reportError(what, err) {
  const msg = `${what}: ${err?.message || err?.name || err || 'unknown error'}`;
  console.error(msg, err);
  state.lastError = msg;
  toast(msg, 6000);
}
window.addEventListener('error', (e) => reportError('Error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError('Error', e.reason));

function renderHint() {
  hintEl.classList.remove('toast');
  const el = state.engaged || document.activeElement;
  let h = '';
  if (state.engaged?.dataset.kind === 'platter')
    h = '◀ ▶ scratch · ▲ fader cut · ▼ spinback · tap = let go';
  else if (state.engaged) h = el.dataset.param === 'tempo' ? '◀ ▶ ±1% · ▲ ▼ fine · tap = done' : '◀ ▶ adjust · tap = done';
  else h = el?.dataset?.hint || 'Swipe to move · tap to select';
  if (hintEl.textContent !== h) hintEl.textContent = h;
}

// ---------- focus navigation ----------

function focusables() {
  return [...document.querySelectorAll('#app .focusable')].filter((el) => el.getClientRects().length);
}

function moveFocus(key) {
  const els = focusables();
  const cur = els.includes(document.activeElement) ? document.activeElement : null;
  if (!cur) return els[0]?.focus();
  const r = cur.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const el of els) {
    if (el === cur) continue;
    const q = el.getBoundingClientRect();
    const dx = q.left + q.width / 2 - cx;
    const dy = q.top + q.height / 2 - cy;
    const [main, cross] =
      key === 'ArrowRight' ? [dx, dy] : key === 'ArrowLeft' ? [-dx, dy] : key === 'ArrowDown' ? [dy, dx] : [-dy, dx];
    if (main <= 4) continue;
    const score = main + Math.abs(cross) * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  best?.focus();
}

// Engaging a control is also a history entry, so a history-based back
// gesture releases it instead of leaving the app.
function engage(el) {
  if (el.dataset.kind === 'platter') {
    const d = decks[+el.dataset.deck];
    if (!d.track) return openLibrary(d.i);
    grab(d);
  }
  state.engaged = el;
  el.classList.add('engaged');
  histPush();
}

function disengage(spin = false) {
  const el = state.engaged;
  if (!el) return;
  el.classList.remove('engaged', 'cut');
  state.engaged = null;
  if (el.dataset.kind === 'platter') {
    const d = decks[+el.dataset.deck];
    release(d);
    if (state.cut[d.i]) {
      state.cut[d.i] = false;
      applyXf(true);
    }
    if (spin) post(d, { type: 'spinback', value: 6 });
  }
}

// Back from a key: skip it if the glasses already did a history back for
// the same gesture.
function backLater(fn) {
  const pressedAt = performance.now();
  setTimeout(() => {
    if (lastPopAt < pressedAt - 50) fn();
  }, 80);
}

function activate(el) {
  ensureAudio(); // actions that need audio await it themselves
  const d = decks[+el.dataset.deck];
  switch (el.dataset.action) {
    case 'play':
      return togglePlay(d);
    case 'cue':
      return cue(d);
    case 'hotcue':
      return hotCue(d);
    case 'start':
      return toStart(d);
    case 'sync':
      return toggleSync(d);
    case 'slip':
      return toggleSlip(d);
    case 'library':
      return openLibrary();
    case 'automix':
      return toggleAutomix();
    case 'quantize':
      return toggleQuantize();
    case 'page':
      return nextPage();
    case 'kill':
      return toggleKill(d, el.dataset.band);
    case 'loop':
      return toggleLoop(d);
    case 'loopsize':
      return resizeLoop(d, +el.dataset.factor);
    case 'jump':
      return beatJump(d, +el.dataset.dir);
    case 'bpm':
      return scaleBpm(d, +el.dataset.factor);
    case 'tap':
      return tapTempo(d);
  }
  if (el.dataset.kind) engage(el);
}

// ---------- library ----------

const libEl = $('#library');
const libList = $('#libList');
const libTitle = $('#libTitle');
const searchInput = $('#search');

const library = {
  open: false,
  forDeck: null,
  home: [],
  rows: [],
  idx: 0,
  stack: [], // screens to go back to: { title, rows, idx }
};

async function buildHome() {
  const rows = [
    { kind: 'search' },
    { kind: 'folder', label: 'Apple Music · Top 50', sub: '30-sec previews', load: () => appleMusicTopSongs() },
    { kind: 'folder', label: 'Audius · Trending', sub: 'Full tracks', load: () => audiusTrending() },
    { kind: 'folder', label: 'Audius · Hip-Hop', sub: 'Full tracks', load: () => audiusTrending('Hip-Hop/Rap') },
    { kind: 'folder', label: 'Audius · Electronic', sub: 'Full tracks', load: () => audiusTrending('Electronic') },
    ...(jamendoEnabled()
      ? [
          { kind: 'folder', label: 'Jamendo · Popular', sub: 'Free CC music · remix-friendly', load: () => jamendoPopular() },
          { kind: 'folder', label: 'Jamendo · Hip-Hop', sub: 'Free CC music · remix-friendly', load: () => jamendoPopular('hiphop') },
          { kind: 'folder', label: 'Jamendo · Electronic', sub: 'Free CC music · remix-friendly', load: () => jamendoPopular('electronic') },
        ]
      : []),
    { kind: 'folder', label: 'Netlabels · Hip-Hop', sub: 'Internet Archive · free CC releases', load: () => archiveReleases({ genre: 'hip hop' }) },
    { kind: 'folder', label: 'Netlabels · Electronic', sub: 'Internet Archive · free CC releases', load: () => archiveReleases({ genre: 'electronic' }) },
    { kind: 'setting', icon: '↔', label: 'Head-tilt filter', sub: 'Experimental · tilt your head to sweep the filter', value: 'OFF', run: (row) => toggleTilt(row) },
    { kind: 'setting', label: 'Device check', sub: 'What audio features these glasses support', run: showDeviceCheck, icon: '🔧' },
    ...DEMOS.map((item) => ({ kind: 'track', item })),
  ];
  library.home = rows;
  if (!library.stack.length) library.rows = rows;
  try {
    const res = await fetch('tracks.json');
    if (res.ok) for (const item of await res.json()) rows.push({ kind: 'track', item: { id: item.url, ...item } });
  } catch {}
  if (library.open) renderLibrary();
}

// The glasses may deliver "back" as history navigation rather than Escape.
// While anything is open (Library, a grabbed control) the app keeps one spare
// history entry as a "back trap" and handles back itself, one level at a time.
// It never navigates history itself (history.back/go are asynchronous and can
// race with the next push, which could leave the app).
let trapArmed = false;
let lastPopAt = -Infinity;

function histPush() {
  if (trapArmed) return;
  try {
    history.pushState({ djay: 'back-trap' }, '');
    trapArmed = true;
  } catch {}
}

window.addEventListener('popstate', () => {
  lastPopAt = performance.now();
  trapArmed = false;
  if (library.open) goBack(true);
  else if (state.engaged) disengage();
  if (library.open || state.engaged) histPush(); // re-arm for the next back
});

// Back from a key or the Back row.
function userBack() {
  goBack(true);
}

function openLibrary(forDeck = null) {
  disengage();
  histPush();
  library.open = true;
  library.forDeck = forDeck;
  libEl.hidden = false;
  if (!library.stack.length) library.rows = library.home;
  renderLibrary();
}

function closeLibrary() {
  library.open = false;
  libEl.hidden = true;
  searchInput.blur();
  const target = library.forDeck ?? 0;
  $(`[data-action="play"][data-deck="${target}"]`).focus();
}

// Open a sub-screen. Entries are tracks, or folders (kind: 'folder') to drill into.
function pushScreen(title, entries, prebuilt = false) {
  library.stack.push({ title: libTitle.textContent, rows: library.rows, idx: library.idx });
  histPush();
  const rows = prebuilt ? entries : entries.map((e) => (e.kind === 'folder' ? e : { kind: 'track', item: e }));
  library.rows = [{ kind: 'back', label: '‹ Back' }, ...rows];
  library.idx = rows.length && !prebuilt ? 1 : 0;
  libTitle.textContent = title;
  renderLibrary();
}

function goBack(fromHistory = false) {
  if (!fromHistory) return userBack();
  const prev = library.stack.pop();
  if (!prev) return closeLibrary();
  if (!library.stack.length) lastSearch.at = -Infinity; // allow searching the same term again
  library.rows = prev.rows;
  library.idx = prev.idx;
  libTitle.textContent = prev.title;
  renderLibrary();
}

async function showDeviceCheck() {
  const yes = (v) => (v ? 'Yes' : 'No');
  const a = document.createElement('audio');
  const can = (t) => a.canPlayType(t) || 'No';
  const rows = [
    { label: 'Web Audio', value: yes(window.AudioContext || window.webkitAudioContext), ok: !!(window.AudioContext || window.webkitAudioContext) },
    { label: 'AudioWorklet', value: yes(window.AudioWorkletNode) + ' (the app falls back if not)', ok: !!window.AudioWorkletNode },
    { label: 'Offline rendering (demo tracks)', value: yes(window.OfflineAudioContext || window.webkitOfflineAudioContext), ok: !!(window.OfflineAudioContext || window.webkitOfflineAudioContext) },
    { label: 'MP3 playback (Audius)', value: can('audio/mpeg'), ok: !!a.canPlayType('audio/mpeg') },
    { label: 'AAC playback (Apple Music)', value: can('audio/mp4; codecs="mp4a.40.2"'), ok: !!a.canPlayType('audio/mp4; codecs="mp4a.40.2"') },
  ];
  let engine = state.engine;
  try {
    await ensureAudio();
    engine = state.engine;
    rows.push({ label: 'Audio engine', value: `${engine} · ${ctx.sampleRate} Hz · ${ctx.state}`, ok: ctx.state === 'running' });
  } catch (err) {
    rows.push({ label: 'Audio engine', value: `Failed: ${err?.message || err}`, ok: false });
  }
  for (const [label, url] of [
    ['Apple Music reachable', 'https://itunes.apple.com/search?term=test&limit=1&media=music'],
    ['Audius reachable', 'https://api.audius.co/v1/tracks/trending?limit=1&app_name=djay-glasses'],
    ['Internet Archive reachable', 'https://archive.org/metadata/netlabels/metadata/title'],
  ]) {
    try {
      const res = await fetch(url);
      rows.push({ label, value: res.ok ? 'Yes' : `HTTP ${res.status}`, ok: res.ok });
    } catch (err) {
      rows.push({ label, value: `No: ${err?.message || err}`, ok: false });
    }
  }
  rows.push({ label: 'Last error', value: state.lastError || 'None', ok: !state.lastError });
  pushScreen('Device check', rows.map((r) => ({ kind: 'info', ...r })), true);
}

async function runFolder(row) {
  const title = libTitle.textContent;
  libTitle.textContent = 'Loading…';
  try {
    const entries = await row.load();
    libTitle.textContent = title;
    pushScreen(entries.length ? row.label : `${row.label} — nothing found`, entries);
  } catch (err) {
    libTitle.textContent = title;
    reportError(`Couldn't open ${row.label}`, err);
  }
}

// Enter, 'change' and 'search' can all fire for one submission (and the
// glasses' composer sends its own), so run each search only once.
let lastSearch = { term: '', at: -Infinity };
async function runSearch(term) {
  term = term.trim();
  if (!term) return;
  if (term === lastSearch.term && performance.now() - lastSearch.at < 3000) return;
  lastSearch = { term, at: performance.now() };
  if (library.stack.length) return; // results already open; only search from Library home
  libTitle.textContent = `Searching “${term}”…`;
  const [au, jm, am, ia] = await Promise.allSettled([
    searchAudius(term),
    jamendoEnabled() ? searchJamendo(term) : [],
    searchAppleMusic(term),
    archiveReleases({ term }),
  ]);
  const rows = [au, jm, am, ia].flatMap((r) => r.value || []);
  libTitle.textContent = 'Library';
  pushScreen(rows.length ? `“${term}”` : `No results for “${term}”`, rows);
}

function rowHTML(row, i) {
  const sel = i === library.idx ? ' sel' : '';
  if (row.kind === 'search') return `<li class="row search-row${sel}" data-i="${i}"></li>`;
  if (row.kind === 'back') return `<li class="row back${sel}">${row.label}</li>`;
  if (row.kind === 'setting') {
    const end = row.value ? `<span class="badge${row.on ? ' on' : ''}">${esc(row.value)}</span>` : '<span class="chev">›</span>';
    return `<li class="row folder${sel}"><span class="ico">${row.icon}</span><span class="txt"><b>${esc(row.label)}</b><small>${esc(row.sub)}</small></span>${end}</li>`;
  }
  if (row.kind === 'info')
    return `<li class="row info${sel}"><span class="txt"><b>${esc(row.label)}</b><small class="${row.ok === false ? 'bad' : row.ok ? 'good' : ''}">${esc(row.value)}</small></span></li>`;
  if (row.kind === 'folder')
    return `<li class="row folder${sel}">${row.art ? `<img src="${esc(row.art)}" alt="">` : '<span class="ico">♫</span>'}<span class="txt"><b>${esc(row.label)}</b><small>${esc(row.sub)}</small></span><span class="chev">›</span></li>`;
  const t = row.item;
  const badge = t.style ? 'DEMO' : t.preview ? '0:30' : t.file || !t.source ? 'FILE' : 'FULL';
  const alts = (t.artAlts || []).join(' ');
  const art = t.art ? `<img src="${esc(t.art)}" data-alts="${esc(alts)}" alt="">` : `<span class="ico">●</span>`;
  const bpm = t.bpm ? ` · ${Math.round(t.bpm)} BPM` : t.license ? ` · ${t.license}` : '';
  return `<li class="row${sel}">${art}<span class="txt"><b>${esc(t.title)}</b><small>${esc(t.artist || '')}${bpm}</small></span><span class="badge">${badge}</span></li>`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function renderLibrary() {
  library.idx = clamp(library.idx, 0, Math.max(0, library.rows.length - 1));
  libList.innerHTML = library.rows.map(rowHTML).join('');
  const searchRow = libList.querySelector('.search-row');
  if (searchRow) searchRow.appendChild(searchInput);
  const row = library.rows[library.idx];
  libList.children[library.idx]?.scrollIntoView({ block: 'nearest' });
  if (row?.kind === 'search') searchInput.focus();
  else {
    searchInput.blur();
    libList.focus();
  }
  $('#libHint').textContent =
    row?.kind === 'track'
      ? '◀ load A · load B ▶ · tap = auto · back = close'
      : row?.kind === 'search'
        ? 'Tap to type a song or artist'
        : 'Tap to open · back = close';
}

function libraryKey(e) {
  const row = library.rows[library.idx];
  const inSearch = document.activeElement === searchInput;
  switch (e.key) {
    case 'ArrowUp':
    case 'ArrowDown':
      e.preventDefault();
      library.idx += e.key === 'ArrowDown' ? 1 : -1;
      renderLibrary();
      return;
    case 'ArrowLeft':
    case 'ArrowRight':
      if (row?.kind !== 'track') return;
      e.preventDefault();
      loadTrack(decks[e.key === 'ArrowLeft' ? 0 : 1], row.item);
      library.forDeck = e.key === 'ArrowLeft' ? 0 : 1;
      closeLibrary();
      return;
    case 'Enter':
      if (row?.kind === 'search') {
        if (searchInput.value.trim()) runSearch(searchInput.value);
        return; // let the glasses open the text composer
      }
      e.preventDefault();
      if (row?.kind === 'back') return goBack();
      if (row?.kind === 'folder') return runFolder(row);
      if (row?.kind === 'setting') return row.run(row);
      if (row?.kind === 'track') {
        const d = library.forDeck != null ? decks[library.forDeck] : decks.find((x) => !x.playing) || decks[1];
        library.forDeck = d.i;
        loadTrack(d, row.item);
        closeLibrary();
      }
      return;
    case 'Escape':
    case 'Backspace':
      if (inSearch && e.key === 'Backspace') return;
      e.preventDefault();
      backLater(userBack);
  }
}

// Library artwork: on a broken image, try the next mirror.
libList.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (img.tagName !== 'IMG') return;
    const [next, ...rest] = (img.dataset.alts || '').split(' ').filter(Boolean);
    if (next) {
      img.dataset.alts = rest.join(' ');
      img.src = next;
    } else img.style.visibility = 'hidden';
  },
  true,
);

searchInput.addEventListener('change', () => runSearch(searchInput.value));
searchInput.addEventListener('search', () => runSearch(searchInput.value));

// ---------- input ----------

document.addEventListener('keydown', (e) => {
  if (library.open) return libraryKey(e);
  const k = e.key;
  const el = state.engaged;

  if (el) {
    const d = decks[+el.dataset.deck];
    if (el.dataset.kind === 'platter') {
      e.preventDefault();
      if (k === 'ArrowRight') stroke(d, 1);
      else if (k === 'ArrowLeft') stroke(d, -1);
      else if (k === 'ArrowUp') {
        state.cut[d.i] = !state.cut[d.i];
        applyXf(true);
        el.classList.toggle('cut', state.cut[d.i]);
      } else if (k === 'ArrowDown') disengage(true);
      else if (k === 'Enter') disengage();
      else if (k === 'Escape' || k === 'Backspace') backLater(() => disengage());
      return;
    }
    e.preventDefault();
    if (k === 'ArrowRight' || k === 'ArrowLeft') nudgeSlider(el, k === 'ArrowRight' ? 1 : -1, false);
    else if (k === 'ArrowUp' || k === 'ArrowDown') nudgeSlider(el, k === 'ArrowUp' ? 1 : -1, true);
    else if (k === 'Enter') disengage();
    else if (k === 'Escape' || k === 'Backspace') backLater(() => disengage());
    return;
  }

  if (k.startsWith('Arrow')) {
    e.preventDefault();
    moveFocus(k);
  } else if (k === 'Enter') {
    e.preventDefault();
    const target = document.activeElement?.classList.contains('focusable') ? document.activeElement : null;
    if (target) activate(target);
    else focusables()[0]?.focus();
  }
  // Escape at the top level is left alone so the glasses can close the app.
});

// ---------- drag scratching ----------
// Drag a platter with a mouse or finger: the record follows the pointer.

let drag = null;

function startScratch(e, d) {
  if (!d.track) return;
  e.preventDefault();
  d.el.platter.focus();
  const pos0 = estPos(d);
  drag = { d, id: e.pointerId, x0: e.clientX, y0: e.clientY, pos0, axis: null, keep: d.held };
  try {
    e.target.setPointerCapture(e.pointerId);
  } catch {}
  grab(d);
  post(d, { type: 'follow', value: pos0 });
}

function moveScratch(e) {
  const dx = e.clientX - drag.x0;
  const dy = e.clientY - drag.y0;
  // Lock to the axis the pointer first moves along, so a stroke can't flip.
  if (!drag.axis && Math.hypot(dx, dy) > 12) drag.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
  const disp = drag.axis === 'y' ? -dy : dx;
  post(drag.d, { type: 'follow', value: drag.pos0 + disp * SECONDS_PER_PX });
}

document.addEventListener('pointerdown', (e) => {
  ensureAudio();
  const plat = e.target.closest?.('.platter');
  if (plat && !library.open) startScratch(e, decks[+plat.dataset.deck]);
});

document.addEventListener('pointermove', (e) => {
  if (drag && e.pointerId === drag.id) moveScratch(e);
});

function endPointer(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const g = drag;
  drag = null;
  // A record grabbed with a swipe/tap stays held; otherwise it plays on.
  if (g.keep) post(g.d, { type: 'hold', value: true });
  else release(g.d);
}
document.addEventListener('pointerup', endPointer);
document.addEventListener('pointercancel', endPointer);

// Desktop convenience: drop an audio file on the left/right half to load it.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const d = decks[e.clientX < window.innerWidth / 2 ? 0 : 1];
  loadTrack(d, { id: file.name, title: file.name.replace(/\.[^.]+$/, ''), artist: 'Local file', file });
});

document.addEventListener('click', (e) => {
  const el = e.target.closest?.('#app .focusable');
  if (el && e.detail) {
    el.focus();
    if (!el.classList.contains('platter')) activate(el);
  }
  const li = e.target.closest?.('#libList .row');
  if (li) {
    library.idx = [...libList.children].indexOf(li);
    renderLibrary();
    libraryKey(new KeyboardEvent('keydown', { key: 'Enter' }));
  }
});

// ---------- boot ----------

for (const d of decks) renderDeckText(d);
renderButtons();
renderSliders();
buildHome();
$('[data-action="library"]').focus();
requestAnimationFrame(frame);

window.djay = { decks, state, library, load: (i, item) => loadTrack(decks[i], item) }; // handy for debugging in the console
