// Authorized artwork stays in memory; only explicit public audio saves may persist its thumbnail.
const MAX_BYTES = 64 * 1024;
// Each wait removes its listener on completion. Aborting an optional cover must
// settle the caller even if storage, decoding or the transport ignores abort.
function wait(pending, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(signal.aborted ? signal.reason : error); });
  });
}
function cancelBody(body) {
  try { void body?.cancel().catch(() => {}); } catch { /* Optional cleanup must not hold the deadline. */ }
}
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

async function validate(blob, art, signal) {
  signal.throwIfAborted();
  if (!(blob instanceof Blob) || blob.size !== art.size || await wait(digest(blob), signal) !== art.sha256) throw new Error('封面校验失败');
  const bytes = new Uint8Array(await wait(blob.arrayBuffer(), signal));
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error('封面格式无效');
  signal.throwIfAborted();
  const decoding = createImageBitmap(blob);
  void decoding.then(image => { if (signal.aborted) image.close(); }, () => {});
  const image = await wait(decoding, signal);
  try { if (image.width !== art.width || image.height !== art.height) throw new Error('封面尺寸不匹配'); }
  finally { image.close(); }
  return blob;
}

export function createArtworkCache({ apiBase, keyFor, cachedTrack, isOffline, timeoutMs = 2500 }) {
  const entries = new Map();
  let generation = 0;
  async function get(track, { signal } = {}) {
    if (signal?.aborted) return null;
    const art = artworkDescriptor(track, apiBase);
    if (!art) return null;
    const key = keyFor(track) + ':' + art.sha256 + ':' + track.access;
    const forCaller = promise => signal ? wait(promise, signal).catch(() => null) : promise;
    if (entries.has(key)) return forCaller(entries.get(key).promise);
    const controller = new AbortController(), epoch = generation;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const entry = { controller, public: track.access === 'public', url: null };
    let response, reader;
    entry.promise = (async () => {
      let blob;
      if (track.access === 'public' && track.offlineAllowed) {
        const item = await wait(cachedTrack(keyFor(track)).catch(() => null), controller.signal);
        if (item?.track?.access === 'public' && item.track.version === track.version && item.track.artwork?.sha256 === art.sha256
          && item.artwork_blob instanceof Blob) {
          try { blob = await validate(item.artwork_blob, art, controller.signal); }
          catch { /* A broken thumbnail must not prevent an online replacement or audio playback. */ }
        }
      }
      if (!blob) {
        controller.signal.throwIfAborted();
        if (isOffline()) return null;
        const fetching = fetch(art.url, { credentials: track.access === 'public' ? 'omit' : 'same-origin',
          cache: 'no-store', signal: controller.signal });
        void fetching.then(value => { if (controller.signal.aborted) cancelBody(value?.body); }, () => {});
        response = await wait(fetching, controller.signal);
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) return null;
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) !== art.size)) throw new Error('封面大小不匹配');
        reader = response.body?.getReader();
        if (!reader) return null;
        const parts = [];
        let count = 0;
        for (;;) { const value = await wait(reader.read(), controller.signal); if (value.done) break;
          if (count + value.value.byteLength > art.size) throw new Error('封面超过大小限制');
          count += value.value.byteLength; parts.push(value.value); }
        blob = await validate(new Blob(parts, { type: 'image/jpeg' }), art, controller.signal);
      }
      if (epoch !== generation || controller.signal.aborted) return null;
      entry.url = URL.createObjectURL(blob);
      return { url: entry.url, blob, artwork: art };
    })().catch(() => null).finally(() => {
      clearTimeout(timeout);
      if (!controller.signal.aborted) controller.abort();
      try { if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } else cancelBody(response?.body); }
      catch { /* An already closed transport can have released the reader. */ }
    });
    entries.set(key, entry);
    entry.promise.then(value => { if (!value && entries.get(key) === entry) entries.delete(key); });
    return forCaller(entry.promise);
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
