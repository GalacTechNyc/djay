// Apple Music catalog via Apple's public iTunes endpoints (no API key).
// Full Apple Music / Spotify streams are DRM-protected and can't be fed
// through Web Audio, so we use the 30-second previews — they mix and
// scratch like any other file.

const art = (url, size = 200) => url?.replace(/\/\d+x\d+bb\./, `/${size}x${size}bb.`);

function fromSearch(r) {
  return {
    id: `am-${r.trackId}`,
    title: r.trackName,
    artist: r.artistName,
    url: r.previewUrl,
    art: art(r.artworkUrl100),
    source: 'Apple Music',
    preview: true,
  };
}

export async function searchAppleMusic(term, country = 'us') {
  const q = new URLSearchParams({ term, media: 'music', entity: 'song', limit: '25', country });
  const res = await fetch(`https://itunes.apple.com/search?${q}`);
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = await res.json();
  return data.results.filter((r) => r.previewUrl).map(fromSearch);
}

export async function appleMusicTopSongs(country = 'us', limit = 50) {
  const res = await fetch(`https://itunes.apple.com/${country}/rss/topsongs/limit=${limit}/json`);
  if (!res.ok) throw new Error(`Charts failed (${res.status})`);
  const data = await res.json();
  return (data.feed?.entry || [])
    .map((e) => {
      const preview = e.link?.find((l) => l.attributes?.type?.startsWith('audio'));
      const images = e['im:image'] || [];
      return {
        id: `am-${e.id?.attributes?.['im:id']}`,
        title: e['im:name']?.label,
        artist: e['im:artist']?.label,
        url: preview?.attributes?.href,
        art: art(images[images.length - 1]?.label),
        source: 'Apple Music',
        preview: true,
      };
    })
    .filter((t) => t.url);
}

// Audius — open music streaming platform with a free public API that
// serves full-length tracks (not just previews) with CORS enabled.
const AUDIUS = 'https://api.audius.co/v1';
const APP = 'app_name=djay-glasses';

function fromAudius(t) {
  return {
    id: `au-${t.id}`,
    title: t.title,
    artist: t.user?.name,
    url: `${AUDIUS}/tracks/${t.id}/stream?${APP}`,
    art: t.artwork?.['480x480'] || t.artwork?.['150x150'],
    bpm: t.bpm && t.bpm > 60 && t.bpm < 200 ? t.bpm : undefined,
    duration: t.duration,
    source: 'Audius',
  };
}

// Long DJ mixes make poor tracks to mix with (and are huge to decode).
const mixable = (t) => t.is_streamable !== false && t.duration > 60 && t.duration < 600;

export async function searchAudius(term) {
  const res = await fetch(`${AUDIUS}/tracks/search?query=${encodeURIComponent(term)}&limit=40&${APP}`);
  if (!res.ok) throw new Error(`Audius search failed (${res.status})`);
  const data = await res.json();
  return data.data.filter(mixable).slice(0, 25).map(fromAudius);
}

export async function audiusTrending(genre) {
  const g = genre ? `&genre=${encodeURIComponent(genre)}` : '';
  const res = await fetch(`${AUDIUS}/tracks/trending?limit=60${g}&${APP}`);
  if (!res.ok) throw new Error(`Audius trending failed (${res.status})`);
  const data = await res.json();
  return data.data.filter(mixable).slice(0, 40).map(fromAudius);
}
