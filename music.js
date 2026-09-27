import { JAMENDO_CLIENT_ID } from './config.js';

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

// Audius content servers come and go, so try the track's own stream URL on
// every mirror it lists, then the API redirect as a last resort.
function audiusUrls(t) {
  const urls = [];
  const s = t.stream;
  if (s?.url) {
    try {
      const u = new URL(s.url);
      for (const host of [...(s.mirrors || []), u.origin]) urls.push(host + u.pathname + u.search);
    } catch {}
  }
  urls.push(`${AUDIUS}/tracks/${t.id}/stream?${APP}`);
  return [...new Set(urls)];
}

function fromAudius(t) {
  const urls = audiusUrls(t);
  return {
    id: `au-${t.id}`,
    title: t.title,
    artist: t.user?.name,
    url: urls[0],
    urls,
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

// ---------- Creative Commons sources ----------
// Only licenses that allow derivative works (no "ND"), so mixing and
// scratching is allowed. The license is shown on each track for attribution.

export function licenseLabel(url) {
  const m = /licenses\/([a-z-]+)/i.exec(url || '');
  if (/publicdomain/i.test(url || '')) return 'Public domain';
  if (m) return `CC ${m[1].toUpperCase()}`;
  return '';
}

// Internet Archive netlabels — free CC releases, no key needed.
const IA_BASE = 'collection:netlabels AND mediatype:audio AND format:"VBR MP3" AND licenseurl:*creativecommons* AND NOT licenseurl:*nd*';

export async function archiveReleases({ genre, term } = {}) {
  let q = IA_BASE;
  if (genre) q += ` AND subject:(${genre})`;
  if (term) q += ` AND (${term.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim()})`;
  const params = new URLSearchParams({ q, rows: '30', output: 'json' });
  for (const f of ['identifier', 'title', 'creator', 'licenseurl']) params.append('fl[]', f);
  params.append('sort[]', 'downloads desc');
  const res = await fetch(`https://archive.org/advancedsearch.php?${params}`);
  if (!res.ok) throw new Error(`Archive search failed (${res.status})`);
  const docs = (await res.json()).response?.docs || [];
  return docs.map((d) => {
    const creator = Array.isArray(d.creator) ? d.creator[0] : d.creator;
    const license = licenseLabel(d.licenseurl);
    return {
      kind: 'folder',
      label: d.title,
      sub: [creator, license].filter(Boolean).join(' · '),
      art: `https://archive.org/services/img/${d.identifier}`,
      load: () => archiveTracks(d.identifier, { creator, license }),
    };
  });
}

export async function archiveTracks(id, { creator, license } = {}) {
  const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Archive item failed (${res.status})`);
  const meta = await res.json();
  const num = (f) => parseInt(f.track, 10) || 0;
  return (meta.files || [])
    .filter((f) => f.format === 'VBR MP3' && !(parseFloat(f.length) > 900))
    .sort((a, b) => num(a) - num(b) || a.name.localeCompare(b.name))
    .map((f) => ({
      id: `ia-${id}-${f.name}`,
      title: f.title || f.name.replace(/\.mp3$/i, '').replace(/_/g, ' '),
      artist: f.artist || f.creator || creator,
      url: `https://archive.org/download/${encodeURIComponent(id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
      art: `https://archive.org/services/img/${id}`,
      source: 'Internet Archive',
      license,
    }));
}

// Jamendo — free CC music, needs a client ID in config.js.
export const jamendoEnabled = () => !!JAMENDO_CLIENT_ID;

async function jamendo(params) {
  const q = new URLSearchParams({
    client_id: JAMENDO_CLIENT_ID,
    format: 'json',
    limit: '30',
    audioformat: 'mp32',
    ccnd: 'false', // exclude no-derivatives licenses
    imagesize: '300',
    ...params,
  });
  const res = await fetch(`https://api.jamendo.com/v3.0/tracks/?${q}`);
  const data = await res.json();
  if (data.headers?.status !== 'success') throw new Error(data.headers?.error_message || 'Jamendo failed');
  return data.results
    .filter((t) => t.audio && t.duration < 900)
    .map((t) => ({
      id: `jm-${t.id}`,
      title: t.name,
      artist: t.artist_name,
      url: t.audio,
      urls: [t.audio, `https://mp3l.jamendo.com/?trackid=${t.id}&format=mp31`],
      art: t.image,
      source: 'Jamendo',
      license: licenseLabel(t.license_ccurl),
    }));
}

export const jamendoPopular = (tag) => jamendo({ order: 'popularity_week', ...(tag ? { tags: tag } : {}) });
export const searchJamendo = (term) => jamendo({ search: term, order: 'relevance' });
