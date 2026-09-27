# djay — DJ app for Meta Ray-Ban Display

A two-deck DJ mixer that runs as a web app on Meta Ray-Ban Display glasses. You play it with the Meta Neural Band: swipe to move around, pinch to press, and swipe on a grabbed record to **scratch**.

- Two turntables with forward and backward scratching (a custom AudioWorklet engine, not stock playback)
- Sync that matches tempo *and* lines up the beats (automatic BPM + beat-grid detection)
- Automix: a beat-matched 16-beat blend with a filter sweep on the outgoing track
- Crossfader, tempo (±16%), and a low-pass/high-pass filter per deck
- Crossfader-cut "transformer" scratches
- Slip mode (scratch without losing the beat) and Quantize (play, cue and scratch snap to the beat)
- 3-band EQ with kills, bass-swap Automix, loops and loop rolls, beat jump, tap tempo
- Head-tilt filter (experimental)
- Music from **Apple Music** (30-second previews), **Audius** (full tracks), 4 built-in demo loops, or your own files

No build step. Plain HTML/CSS/JS, about 60 KB in total.

## Controls (Neural Band)

| Where | Gesture | Does |
|---|---|---|
| Anywhere | Swipe ◀ ▶ ▲ ▼ | Move focus |
| Button | Pinch/tap | Press it |
| **Platter** | Tap | Grab the record ✋ |
| Grabbed platter | Swipe ▶ / ◀ | Scratch forward / back |
| Grabbed platter | Swipe ▲ | Toggle crossfader cut (transformer) |
| Grabbed platter | Swipe ▼ | Let go with a spinback |
| Grabbed platter | Tap | Let go (the record plays on) |
| Slider | Tap, then ◀ ▶ | Adjust (▲ ▼ = fine tempo), tap again when done |
| Library track | ◀ / ▶ | Load onto deck A / B |
| Library | Tap search row | Opens the glasses keyboard |

To practice a baby scratch: grab the platter, then swipe right, left, right, left in time with the beat on the "ahh" vocal in the demo tracks.

### Pages

The **☰ Page** button (middle column) flips the bottom controls between three pages:

- **Deck**: ▶ · CUE · ↩ hot cue · ⏮ start · SYNC · SLIP, plus TEMPO and FILTER.
- **Loop**: ◀◀ / ▶▶ beat jump · LOOP (¼ to 32 beats; ½ / ×2 change the size) · BPM ÷2 / ×2 (fix a tempo detected at half or double speed) · TAP (tap 4+ times on the beat to set the tempo and beat grid). With Quantize on, loops start on the beat. With Slip on, a loop is a "loop roll": when it ends, the track rejoins where it would have been.
- **EQ**: LOW / MID / HIGH (−24 to +6 dB; all the way down = kill) and KILL LO / MID / HI buttons.

Automix does a **bass swap**: the incoming track's bass stays out until halfway through the blend, then the basslines swap, so two kick drums never play at once.

### Head-tilt filter (experimental)

Library → **Head-tilt filter** uses the glasses' motion sensor: tilt your head right for a high-pass sweep and left for a low-pass sweep on the deck you're hearing. Small movements are ignored; your head position when you turn it on counts as level.

### Cueing

- **CUE** sets the cue point right where the track is, playing or paused.
- **↩** (hot cue) jumps to the cue point, keeping play/pause as it is.
- **⏮** jumps to the beginning of the track.

### Slip and Quantize

- **SLIP** (per deck): while you scratch, hold or spin back the record, the track keeps running silently underneath. A yellow line on the waveform shows where. Let go and playback rejoins it, so you never lose the beat.
- **QUANTIZE** (middle column): pressing play starts a deck in step with the other deck's beats (or on its own nearest beat if the other isn't playing). Cue points snap to the nearest beat, ↩ and ⏮ jumps keep your place in the beat, and letting go of a scratch lands back in step with the other deck.

Swipe scratches are shaped like a hand movement: each swipe moves the record 0.25 s with an ease-in/ease-out curve, so strokes start, stop and reverse smoothly.

## Music sources

| Source | What you get | Why |
|---|---|---|
| **Audius** | Full tracks, search + trending | Open music platform with a free public API that lets apps get at the raw audio |
| **Apple Music** | 30-second previews of almost any song, search + Top 50 | Full Apple Music songs are DRM-locked. DJ apps like djay get full songs through a private Apple partnership |
| **Internet Archive Netlabels** | Full tracks, free Creative Commons releases (hip-hop, electronic, search) | Open API, no key. Filtered to licenses that allow remixing |
| **Jamendo** | Full tracks, free Creative Commons music | Needs a free client ID in `config.js` (see below). Filtered to licenses that allow remixing |
| **Your files** | Full tracks | Put MP3/M4A files in `tracks/` and list them in `tracks.json` (see below) |
| **Spotify** | ✗ | No raw audio access, and Spotify's developer terms ban DJ/mixing apps |
| **SoundCloud** | ✗ | API keys are by application only, and the API terms ban modifying tracks or building an on-demand library from many uploaders. DJ apps get it through a partnership |

Creative Commons tracks show their license (for example "CC BY-SA") next to the artist name, as their licenses require.

**Enabling Jamendo:** create a free account at [devportal.jamendo.com](https://devportal.jamendo.com), create an app, and paste its Client ID into `config.js`. Push, and the Jamendo rows appear in the Library.

Audius tracks are fetched from whichever of Audius's mirror servers responds. Downloads only give up if they can't connect or stop receiving data, so slow connections still work.

`tracks.json` example:

```json
[
  { "title": "My Song", "artist": "Me", "url": "tracks/my-song.mp3" },
  { "title": "Other Song", "artist": "Someone", "url": "https://example.com/song.mp3", "bpm": 124 }
]
```

`bpm` is optional; it's detected automatically. Remote URLs must allow CORS.

## Run it locally

```bash
python3 -m http.server 8600
```

Open http://localhost:8600 in Chrome. The arrow keys stand in for band swipes, Enter for a pinch, and Escape for back. You can also drag the platters with the mouse, or drop an audio file on the left or right half of the page to load it onto that deck. For a realistic preview, use Meta's **Ray-Ban Display Simulator** Chrome extension.

## Troubleshooting on the glasses

If tracks won't load or play, open **Library → Device check**. It shows which audio features the glasses support, whether Apple Music and Audius are reachable, and the last error. Errors also appear in the bottom bar. If the main audio engine (AudioWorklet) is missing, the app switches to a fallback automatically; add `?engine=fallback` to the URL to force it.

## Put it on the glasses

1. Host the folder on any HTTPS host. GitHub Pages works: repo **Settings → Pages → Deploy from branch → `main` / root**. So does Vercel or Netlify.
2. In the Meta AI app, turn on developer mode for your glasses and add the web app by URL. See [Meta's web app docs](https://wearables.developer.meta.com/docs/develop/webapps).

## Files

| File | What |
|---|---|
| `deck-core.js` | Turntable audio engine: variable-speed, reversible playback, motor inertia, scratch strokes, spinback |
| `deck-worklet.js` | Runs the engine on the audio thread (AudioWorklet); `app.js` falls back to ScriptProcessor |
| `app.js` | Decks, mixer, sync, automix, D-pad focus, library, gestures |
| `music.js` | Apple Music, Audius, Internet Archive and Jamendo catalogs |
| `config.js` | Optional API keys (Jamendo) |
| `analyze.js` | Waveform peaks, BPM + beat-grid detection |
| `synth.js` | Synthesized demo tracks (so it works with zero audio files) |
