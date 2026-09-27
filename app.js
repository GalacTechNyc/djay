import { DEMOS, renderDemo } from './synth.js';
import { DeckCore } from './deck-core.js';
import { computePeaks, detectTempo, PEAKS_PER_SEC } from './analyze.js';
import { searchAppleMusic, appleMusicTopSongs, searchAudius, audiusTrending } from './music.js';

const $ = (s) => document.querySelector(s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const COLORS = ['#22d3ee', '#ff4fd8'];
const TEMPO_RANGE = 0.16;
const DRAG_MODE = document.documentElement.dataset.drag === '1'; // set in index.html

// ---------- state ----------

const state = {
  xf: 0.5,
  cut: [false, false],
  engaged: null,
  automix: null,
  audioReady: null,
  toastUntil: 0,
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
  master.connect(limiter);
  limiter.connect(ctx.destination);
  for (const d of decks) {
    d.node = useWorklet ? makeWorkletDeck() : makeScriptDeck();
    d.filter = ctx.createBiquadFilter();
    d.xfGain = ctx.createGain();
    d.node.connect(d.filter);
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

const post = (d, msg, transfer) => d.node?.port.postMessage(msg, transfer || []);

function onDeckMessage(d, m) {
  if (m.type === 'pos') {
    d.pos = m.pos;
    d.rate = m.rate;
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

// Both decks at full volume in the middle, fading out toward the far side.
function applyXf(instant = false) {
  if (!ctx) return;
  const x = state.xf;
  const g = [x <= 0.5 ? 1 : Math.cos((x - 0.5) * Math.PI), x >= 0.5 ? 1 : Math.cos((0.5 - x) * Math.PI)];
  decks.forEach((d, i) => {
    const v = state.cut[i] ? 0 : g[i];
    d.xfGain.gain.setTargetAtTime(v, ctx.currentTime, instant ? 0.003 : 0.015);
  });
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
      const src = item.file ? item.file : await fetchAudio(item.url);
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
    d.pos = d.cue;
    d.rate = 0;
    const Lc = L.slice();
    const Rc = R === L ? null : R.slice();
    post(d, { type: 'load', L: Lc, R: Rc, sampleRate: buf.sampleRate, loop: !!item.loop }, Rc ? [Lc.buffer, Rc.buffer] : [Lc.buffer]);
    post(d, { type: 'tempo', value: 1 });
    post(d, { type: 'seek', value: d.cue });
    d.el.disc.style.backgroundImage = item.art ? `url("${item.art}")` : '';
    d.el.platter.classList.toggle('has-art', !!item.art);
    toast(`${d.name} ← ${item.title}`);
  } catch (err) {
    reportError(`Couldn't load ${item.title}`, err);
    d.track = null;
  } finally {
    d.loading = false;
    renderDeckText(d);
    renderButtons();
  }
}

async function fetchAudio(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    return await res.arrayBuffer();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('download timed out');
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
  post(d, { type: 'play', value: d.playing });
  renderButtons();
}

function cue(d) {
  if (!d.track) return;
  if (d.playing) {
    d.playing = false;
    post(d, { type: 'play', value: false });
    post(d, { type: 'seek', value: d.cue });
    toast(`${d.name}: back to cue`);
  } else {
    d.cue = estPos(d);
    toast(`${d.name}: cue set ${fmt(d.cue)}`);
  }
  renderButtons();
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
  post(d, { type: 'seek', value: Math.max(0, target) });
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

// ---------- automix ----------

async function toggleAutomix() {
  await ensureAudio();
  if (state.automix) {
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
  matchTempo(to, from);
  alignPhase(to, from);
  to.playing = true;
  post(to, { type: 'play', value: true });

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
  m.from.filterVal = p > 0.4 ? ((p - 0.4) / 0.6) * 0.75 : 0;
  applyFilter(m.from);
  if (p >= 1) {
    m.from.playing = false;
    post(m.from, { type: 'play', value: false });
    m.from.filterVal = 0;
    applyFilter(m.from);
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
  post(d, { type: 'hold', value: false });
  d.el.platter.classList.remove('held');
  if (state.cut[d.i]) {
    state.cut[d.i] = false;
    applyXf(true);
  }
}

function stroke(d, dir) {
  post(d, { type: 'stroke', value: dir * 3 });
  d.el.platter.classList.remove('flick-l', 'flick-r');
  void d.el.platter.offsetWidth;
  d.el.platter.classList.add(dir > 0 ? 'flick-r' : 'flick-l');
}

// ---------- sliders ----------

const SLIDERS = {
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
  const tag = d.track.preview ? ' · 0:30 preview' : '';
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
  }
  $('[data-action="automix"]').classList.toggle('on', !!state.automix);
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
    h = DRAG_MODE ? 'Drag or swipe to scratch · ▲ cut · ▼ spinback · tap = let go' : '◀ ▶ scratch · ▲ fader cut · ▼ spinback · tap = let go';
  else if (state.engaged) h = el.dataset.param === 'tempo' ? '◀ ▶ ±1% · ▲ ▼ fine · tap = done' : '◀ ▶ adjust · tap = done';
  else h = el?.dataset?.hint || 'Swipe to move · tap to select';
  if (hintEl.textContent !== h) hintEl.textContent = h;
}

// ---------- focus navigation ----------

function focusables() {
  return [...document.querySelectorAll('#app .focusable')];
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

function engage(el) {
  state.engaged = el;
  el.classList.add('engaged');
  if (el.dataset.kind === 'platter') {
    const d = decks[+el.dataset.deck];
    if (!d.track) {
      disengage();
      return openLibrary(d.i);
    }
    grab(d);
  }
}

function disengage(spin = false) {
  const el = state.engaged;
  if (!el) return;
  el.classList.remove('engaged');
  state.engaged = null;
  if (el.dataset.kind === 'platter') {
    const d = decks[+el.dataset.deck];
    release(d);
    if (spin) post(d, { type: 'spinback', value: 6 });
  }
}

function activate(el) {
  ensureAudio(); // actions that need audio await it themselves
  const d = decks[+el.dataset.deck];
  switch (el.dataset.action) {
    case 'play':
      return togglePlay(d);
    case 'cue':
      return cue(d);
    case 'sync':
      return toggleSync(d);
    case 'library':
      return openLibrary();
    case 'automix':
      return toggleAutomix();
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
  homeIdx: 0,
  view: 'home',
};

async function buildHome() {
  const rows = [
    { kind: 'search' },
    { kind: 'folder', label: 'Apple Music · Top 50', sub: '30-sec previews', load: () => appleMusicTopSongs() },
    { kind: 'folder', label: 'Audius · Trending', sub: 'Full tracks', load: () => audiusTrending() },
    { kind: 'folder', label: 'Audius · Hip-Hop', sub: 'Full tracks', load: () => audiusTrending('Hip-Hop/Rap') },
    { kind: 'folder', label: 'Audius · Electronic', sub: 'Full tracks', load: () => audiusTrending('Electronic') },
    {
      kind: 'setting',
      label: `Drag scratch: ${DRAG_MODE ? 'ON' : 'OFF'}`,
      sub: 'Scratch by dragging on the band · app reloads',
      run: toggleDragMode,
    },
    { kind: 'setting', label: 'Device check', sub: 'What audio features these glasses support', run: showDeviceCheck, icon: '🔧' },
    ...DEMOS.map((item) => ({ kind: 'track', item })),
  ];
  library.home = rows;
  if (library.view === 'home') library.rows = rows;
  try {
    const res = await fetch('tracks.json');
    if (res.ok) for (const item of await res.json()) rows.push({ kind: 'track', item: { id: item.url, ...item } });
  } catch {}
  if (library.open) renderLibrary();
}

function openLibrary(forDeck = null) {
  disengage();
  library.open = true;
  library.forDeck = forDeck;
  libEl.hidden = false;
  if (library.view === 'home') library.rows = library.home;
  renderLibrary();
}

function closeLibrary() {
  library.open = false;
  libEl.hidden = true;
  searchInput.blur();
  const target = library.forDeck ?? 0;
  $(`[data-action="play"][data-deck="${target}"]`).focus();
}

function showRows(title, rows) {
  library.view = 'list';
  library.homeIdx = library.idx;
  library.rows = [{ kind: 'back', label: '‹ Back' }, ...rows.map((item) => ({ kind: 'track', item }))];
  library.idx = rows.length ? 1 : 0;
  libTitle.textContent = title;
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
  ]) {
    try {
      const res = await fetch(url);
      rows.push({ label, value: res.ok ? 'Yes' : `HTTP ${res.status}`, ok: res.ok });
    } catch (err) {
      rows.push({ label, value: `No: ${err?.message || err}`, ok: false });
    }
  }
  rows.push({ label: 'Last error', value: state.lastError || 'None', ok: !state.lastError });
  library.view = 'list';
  library.homeIdx = library.idx;
  library.rows = [{ kind: 'back', label: '‹ Back' }, ...rows.map((r) => ({ kind: 'info', ...r }))];
  library.idx = 0;
  libTitle.textContent = 'Device check';
  renderLibrary();
}

function goHome() {
  library.view = 'home';
  library.rows = library.home;
  library.idx = library.homeIdx;
  libTitle.textContent = 'Library';
  renderLibrary();
}

async function runFolder(row) {
  libTitle.textContent = 'Loading…';
  try {
    showRows(row.label, await row.load());
  } catch (err) {
    libTitle.textContent = 'Library';
    toast(`Couldn't reach ${row.label.split(' ·')[0]}`);
  }
}

async function runSearch(term) {
  term = term.trim();
  if (!term) return;
  libTitle.textContent = `Searching “${term}”…`;
  const [au, am] = await Promise.allSettled([searchAudius(term), searchAppleMusic(term)]);
  const rows = [...(au.value || []), ...(am.value || [])];
  showRows(rows.length ? `“${term}”` : `No results for “${term}”`, rows);
}

function rowHTML(row, i) {
  const sel = i === library.idx ? ' sel' : '';
  if (row.kind === 'search') return `<li class="row search-row${sel}" data-i="${i}"></li>`;
  if (row.kind === 'back') return `<li class="row back${sel}">${row.label}</li>`;
  if (row.kind === 'setting')
    return row.icon
      ? `<li class="row folder${sel}"><span class="ico">${row.icon}</span><span class="txt"><b>${esc(row.label)}</b><small>${esc(row.sub)}</small></span><span class="chev">›</span></li>`
      : `<li class="row folder${sel}"><span class="ico">✋</span><span class="txt"><b>${esc(row.label)}</b><small>${esc(row.sub)}</small></span><span class="badge${DRAG_MODE ? ' on' : ''}">${DRAG_MODE ? 'ON' : 'OFF'}</span></li>`;
  if (row.kind === 'info')
    return `<li class="row info${sel}"><span class="txt"><b>${esc(row.label)}</b><small class="${row.ok === false ? 'bad' : row.ok ? 'good' : ''}">${esc(row.value)}</small></span></li>`;
  if (row.kind === 'folder')
    return `<li class="row folder${sel}"><span class="ico">♫</span><span class="txt"><b>${esc(row.label)}</b><small>${esc(row.sub)}</small></span><span class="chev">›</span></li>`;
  const t = row.item;
  const badge = t.style ? 'DEMO' : t.preview ? '0:30' : t.source === 'Audius' ? 'FULL' : 'FILE';
  const art = t.art ? `<img src="${esc(t.art)}" alt="">` : `<span class="ico">●</span>`;
  const bpm = t.bpm ? ` · ${Math.round(t.bpm)} BPM` : '';
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
      if (row?.kind === 'back') return goHome();
      if (row?.kind === 'folder') return runFolder(row);
      if (row?.kind === 'setting') return row.run();
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
      if (library.view !== 'home') goHome();
      else closeLibrary();
  }
}

searchInput.addEventListener('change', () => runSearch(searchInput.value));
searchInput.addEventListener('search', () => runSearch(searchInput.value));

// ---------- input ----------

document.addEventListener('keydown', (e) => {
  if (e.isTrusted) {
    const now = performance.now();
    lastRealKeyAt = now;
    // Drop a real key that duplicates a gesture we already turned into a key,
    // or arrows that echo a drag-scratch.
    if (now - lastSynthAt < 300 || (drag && e.key.startsWith('Arrow')) || now - lastDragEndAt < 200) {
      e.preventDefault();
      return;
    }
  }
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
      else if (k === 'Enter' || k === 'Escape' || k === 'Backspace') disengage();
      return;
    }
    e.preventDefault();
    if (k === 'ArrowRight' || k === 'ArrowLeft') nudgeSlider(el, k === 'ArrowRight' ? 1 : -1, false);
    else if (k === 'ArrowUp' || k === 'ArrowDown') nudgeSlider(el, k === 'ArrowUp' ? 1 : -1, true);
    else if (k === 'Enter' || k === 'Escape' || k === 'Backspace') disengage();
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
// Desktop/touch: drag a platter directly. Glasses in drag mode: the band's
// drag arrives as pointer events. A drag on a grabbed record scratches;
// otherwise short flicks and taps are read as swipes and pinches, so the app
// stays navigable even if drag mode stops the arrow keys from coming through.

let drag = null;
let gesture = null;
let lastRealKeyAt = -Infinity;
let lastSynthAt = -Infinity;
let lastDragEndAt = -Infinity;

function startScratch(e, d) {
  if (!d.track) return;
  e.preventDefault();
  d.el.platter.focus();
  drag = { d, x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId, keep: d.held, sx: e.clientX, sy: e.clientY, at: performance.now() };
  try {
    e.target.setPointerCapture(e.pointerId);
  } catch {}
  grab(d);
}

document.addEventListener('pointerdown', (e) => {
  ensureAudio();
  if (DRAG_MODE) {
    const grabbed = !library.open && state.engaged?.dataset.kind === 'platter';
    if (grabbed) return startScratch(e, decks[+state.engaged.dataset.deck]);
    gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now() };
    return;
  }
  const plat = e.target.closest?.('.platter');
  if (plat && !library.open) startScratch(e, decks[+plat.dataset.deck]);
});

document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dt = Math.max(1, e.timeStamp - drag.t);
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  const v = (Math.abs(dx) >= Math.abs(dy) ? dx : -dy) / dt;
  post(drag.d, { type: 'drag', value: clamp(v * 1.2, -8, 8) });
  Object.assign(drag, { x: e.clientX, y: e.clientY, t: e.timeStamp });
});

function endPointer(e) {
  if (drag && e.pointerId === drag.id) {
    const g = drag;
    if (!g.keep) release(g.d);
    else post(g.d, { type: 'drag', value: 0 });
    drag = null;
    lastDragEndAt = performance.now();
    // In drag mode a quick, still touch on a grabbed record is a tap: let go.
    const still = Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 20 && lastDragEndAt - g.at < 350;
    if (DRAG_MODE && still && e.type === 'pointerup' && state.engaged?.dataset.kind === 'platter') {
      setTimeout(() => {
        if (lastRealKeyAt > g.at) return;
        lastSynthAt = performance.now();
        disengage();
      }, 120);
    }
  }
  if (gesture && e.pointerId === gesture.id && e.type === 'pointerup') {
    const g = gesture;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const key =
      Math.hypot(dx, dy) < 20
        ? 'Enter'
        : Math.abs(dx) >= Math.abs(dy)
          ? dx > 0 ? 'ArrowRight' : 'ArrowLeft'
          : dy > 0 ? 'ArrowDown' : 'ArrowUp';
    // If the glasses also sent a real key for this gesture, let that win.
    setTimeout(() => {
      if (lastRealKeyAt > g.at) return;
      lastSynthAt = performance.now();
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    }, 120);
  }
  if (gesture && e.pointerId === gesture.id) gesture = null;
}
document.addEventListener('pointerup', endPointer);
document.addEventListener('pointercancel', endPointer);

function toggleDragMode() {
  try {
    localStorage.setItem('djay.drag', DRAG_MODE ? '0' : '1');
  } catch {}
  const url = new URL(location.href);
  url.searchParams.delete('drag');
  location.replace(url);
}

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
  if (DRAG_MODE && e.pointerType !== 'mouse') return;
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
if (DRAG_MODE) toast('Drag scratch ON — grab a record, then drag', 3000);
requestAnimationFrame(frame);

window.djay = { decks, state, library, input: () => ({ now: performance.now(), lastRealKeyAt, lastSynthAt, lastDragEndAt, drag: !!drag, gesture: !!gesture }) }; // handy for debugging in the console
