# djay — DJ app for Meta Ray-Ban Display

A two-deck DJ mixer that runs as a web app on Meta Ray-Ban Display glasses. You play it with the Meta Neural Band: swipe to move around, pinch to press, and swipe on a grabbed record to **scratch**.

- Two turntables with forward and backward scratching (a custom AudioWorklet engine, not stock playback)
- Sync that matches tempo *and* lines up the beats (automatic BPM + beat-grid detection)
- Automix: a beat-matched 16-beat blend with a filter sweep on the outgoing track
- Crossfader, tempo (±16%), and a low-pass/high-pass filter per deck
- Crossfader-cut "transformer" scratches
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
| Grabbed platter (drag mode) | Drag ◀ ▶ | Scratch at your hand's speed |
| Slider | Tap, then ◀ ▶ | Adjust (▲ ▼ = fine tempo), tap again when done |
| Library track | ◀ / ▶ | Load onto deck A / B |
| Library | Tap search row | Opens the glasses keyboard |

To practice a baby scratch: grab the platter, then swipe right, left, right, left in time with the beat on the "ahh" vocal in the demo tracks.

**Drag scratch toggle:** in the Library, turn on **Drag scratch**. The app reloads, and after that, dragging on a grabbed record scratches at your hand's speed. A tap lets go. The app has to reload because Meta only turns on the band's drag input if it's switched on when the page first loads. While drag mode is on, the app also reads quick flicks and taps as swipes and presses, so you can always get back to the toggle. You can also force it with `?drag=1` or `?drag=0` in the URL.

## Music sources

| Source | What you get | Why |
|---|---|---|
| **Audius** | Full tracks, search + trending | Open music platform with a free public API that lets apps get at the raw audio |
| **Apple Music** | 30-second previews of almost any song, search + Top 50 | Full Apple Music songs are DRM-locked. DJ apps like djay get full songs through a private Apple partnership |
| **Your files** | Full tracks | Put MP3/M4A files in `tracks/` and list them in `tracks.json` (see below) |
| **Spotify** | ✗ | No raw audio access, and Spotify's developer terms ban DJ/mixing apps |

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

## Put it on the glasses

1. Host the folder on any HTTPS host. GitHub Pages works: repo **Settings → Pages → Deploy from branch → `main` / root**. So does Vercel or Netlify.
2. In the Meta AI app, turn on developer mode for your glasses and add the web app by URL. See [Meta's web app docs](https://wearables.developer.meta.com/docs/develop/webapps).

## Files

| File | What |
|---|---|
| `deck-worklet.js` | Turntable audio engine: variable-speed, reversible playback, motor inertia, scratch strokes, spinback |
| `app.js` | Decks, mixer, sync, automix, D-pad focus, library, gestures |
| `music.js` | Apple Music + Audius catalogs |
| `analyze.js` | Waveform peaks, BPM + beat-grid detection |
| `synth.js` | Synthesized demo tracks (so it works with zero audio files) |
