// Authorized artwork stays in memory; only explicit public audio saves may persist its thumbnail.
const MAX_BYTES = 64 * 1024;
const digest = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');

export function artworkDescriptor(track, apiBase, origin = location.origin) {
  const art = track?.artwork;
  if (!art || art.contentType !== 'image/jpeg' || !/^[a-f0-9]{64}$/.test(art.sha256)
    || !Number.isInteger(art.size) || art.size < 4 || art.size > MAX_BYTES
    || !Number.isInteger(art.width) || !Number.isInteger(art.height)
    || art.width < 1 || art.height < 1 || art.width > 256 || art.height > 256) return null;
  if (!track.instanceId || !track.songId || !/^[a-f0-9]{64}$/.test(track.version || '')) return null;
  try {
    const url = new URL(track.cover_url, origin);
    if (url.origin !== origin || url.username || url.password || url.hash
      || url.pathname !== apiBase + '/artwork/' + encodeURIComponent(track.songId)
      || [...url.searchParams].length !== 2 || url.searchParams.get('instanceId') !== track.instanceId
      || url.searchParams.get('version') !== track.version) return null;
    return { ...art, url: url.href };
  } catch { return null; }
}

async function validate(blob, art) {
  if (!(blob instanceof Blob) || blob.size !== art.size || await digest(blob) !== art.sha256) throw new Error('封面校验失败');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error('封面格式无效');
  const image = await createImageBitmap(blob);
  try { if (image.width !== art.width || image.height !== art.height) throw new Error('封面尺寸不匹配'); }
  finally { image.close(); }
  return blob;
}

export function createArtworkCache({ apiBase, keyFor, cachedTrack, isOffline }) {
  const entries = new Map();
  let generation = 0;
  async function get(track) {
    const art = artworkDescriptor(track, apiBase);
    if (!art) return null;
    const key = keyFor(track) + ':' + art.sha256 + ':' + track.access;
    if (entries.has(key)) return entries.get(key).promise;
    const controller = new AbortController(), epoch = generation;
    const timeout = setTimeout(() => controller.abort(), 2500);
    const entry = { controller, public: track.access === 'public', url: null };
    entry.promise = (async () => {
      let blob;
      if (track.access === 'public' && track.offlineAllowed) {
        const item = await cachedTrack(keyFor(track)).catch(() => null);
        if (item?.track?.access === 'public' && item.track.version === track.version && item.track.artwork?.sha256 === art.sha256
          && item.artwork_blob instanceof Blob) {
          try { blob = await validate(item.artwork_blob, art); }
          catch { /* A broken thumbnail must not prevent an online replacement or audio playback. */ }
        }
      }
      if (!blob) {
        if (isOffline()) return null;
        const response = await fetch(art.url, { credentials: track.access === 'public' ? 'omit' : 'same-origin',
          cache: 'no-store', signal: controller.signal });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) return null;
        const reader = response.body.getReader(), parts = [];
        let count = 0;
        try {
          for (;;) { const value = await reader.read(); if (value.done) break; count += value.value.byteLength;
            if (count > MAX_BYTES) throw new Error('封面超过大小限制'); parts.push(value.value); }
        } finally { if (count > MAX_BYTES) await reader.cancel(); reader.releaseLock(); }
        blob = await validate(new Blob(parts, { type: 'image/jpeg' }), art);
      }
      if (epoch !== generation || controller.signal.aborted) return null;
      entry.url = URL.createObjectURL(blob);
      return { url: entry.url, blob, artwork: art };
    })().catch(() => null).finally(() => clearTimeout(timeout));
    entries.set(key, entry);
    entry.promise.then(value => { if (!value && entries.get(key) === entry) entries.delete(key); });
    return entry.promise;
  }
  return { get,
    invalidate(keepPublic = false) {
      generation++;
      for (const [key, entry] of entries) {
        if (keepPublic && entry.public && entry.url) continue;
        entry.controller.abort(); if (entry.url) URL.revokeObjectURL(entry.url); entries.delete(key);
      }
    },
  };
}
