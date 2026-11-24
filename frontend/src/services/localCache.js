import { validateAlacStreamBlob } from "../utils/alac-stream.js";

const DB_NAME = "music-splayer-web-cache-v1";
const STORE = "tracks";
const LIMIT_BYTES = 1_500 * 1024 * 1024;

let dbPromise;
let cachedDatabase;
let trimPromise = Promise.resolve();
const activeAudioDownloads = new Map();

// Shared database opening and eviction may outlive one caller. Cancellation
// releases that caller without closing another operation's database or work.
function waitForStorage(pending, signal) {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const cancelled = () => { signal.removeEventListener("abort", cancelled); reject(signal.reason); };
    if (signal.aborted) cancelled();
    else signal.addEventListener("abort", cancelled, { once: true });
    Promise.resolve(pending).then(value => {
      signal.removeEventListener("abort", cancelled);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { signal.removeEventListener("abort", cancelled); reject(signal.aborted ? signal.reason : error); });
  });
}

function releaseDatabase(db) {
  if (cachedDatabase === db) { cachedDatabase = null; dbPromise = null; }
  db.close();
}

function openDb() {
  if (dbPromise) return dbPromise;
  const opening = new Promise((resolve, reject) => {
    let request, settled = false;
    const fail = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(error);
    };
    // A blocked or stalled open is optional storage, not an infinite gate for online playback.
    const timer = setTimeout(() => fail(new DOMException("本地音频存储连接超时，请重试", "TimeoutError")), 3000);
    try {
      request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (settled) { request.transaction.abort(); return; }
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onblocked = () => fail(new DOMException("本地音频存储被其他页面占用，请稍后重试", "InvalidStateError"));
      request.onerror = () => fail(request.error || new Error("本地音频存储无法打开"));
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        settled = true; clearTimeout(timer); cachedDatabase = db;
        db.onversionchange = () => releaseDatabase(db);
        db.onclose = () => { if (cachedDatabase === db) { cachedDatabase = null; dbPromise = null; } };
        resolve(db);
      };
    } catch (error) { fail(error); }
  });
  dbPromise = opening;
  // A rejected open must not poison every future attempt in this page.
  void opening.catch(() => { if (dbPromise === opening) dbPromise = null; });
  return opening;
}

function tx(mode, handler, { signal, timeoutMs = mode === "readonly" ? 3000 : 10000 } = {}) {
  signal?.throwIfAborted();
  const execute = retry => waitForStorage(openDb(), signal).then(
    (db) =>
      new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        let transaction;
        try { transaction = db.transaction(STORE, mode); }
        catch (error) {
          // Reopen only before any request was submitted. Failed writes are never retried implicitly.
          if (retry && error.name === "InvalidStateError") {
            releaseDatabase(db); resolve(execute(false)); return;
          }
          reject(error); return;
        }
        let result, settled = false, timer;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancelled);
          callback(value);
        };
        // IDB callbacks run after the Promise executor. Catch their synchronous
        // write errors explicitly so quota failures cannot become page errors
        // or be mistaken for a user cancellation.
        const fail = (error) => {
          finish(reject, error);
          try { transaction.abort(); } catch { /* Already completed or aborted. */ }
        };
        const cancelled = () => fail(signal.reason || new DOMException("音频缓存写入已取消", "AbortError"));
        transaction.oncomplete = () => finish(resolve,
          result && typeof result === "object" && "result" in result ? result.result : result,
        );
        transaction.onerror = (event) => fail(event.target.error || transaction.error || new Error("音频缓存操作失败"));
        transaction.onabort = () => finish(reject, transaction.error || new Error("音频缓存写入已取消"));
        signal?.addEventListener("abort", cancelled, { once: true });
        if (timeoutMs) timer = setTimeout(() => fail(new DOMException(mode === "readonly"
          ? "本地音频存储读取超时，请重试" : "本地音频存储写入超时，请重试", "TimeoutError")), timeoutMs);
        try { result = handler(transaction.objectStore(STORE), fail); } catch (error) { fail(error); }
      }),
  );
  return execute(true);
}

export function cacheKey(task) {
  if (!task) return "";
  const identity = task.track_id || task.selected_id || task.source_id || task.query || task.id;
  const base = [task.platform, identity, task.quality].filter(Boolean).join(":");
  if (!base) return "";

  // A Lossless task may now use the packet based WASM transport,
  // while the same track can still be cached as the legacy FLAC/fMP4 object.
  // Keep those representations in separate entries.  Omitting the suffix for
  // ordinary tasks preserves compatibility with caches written by v1.
  const streamingMode = String(task.streaming_mode || "").trim().toLowerCase();
  if (streamingMode === "wasm_alac") return `${base}:wasm_alac_v2`;
  return base;
}

export function getCachedTrack(key, options) {
  return tx("readonly", (store) => store.get(key), options);
}

export async function putCachedTrack(key, value, { signal, onCommit } = {}) {
  if (!key) return null;
  const hasIncomingBlob = Object.prototype.hasOwnProperty.call(value || {}, "blob");
  let hadBlob = false;
  // Read and merge in the same transaction: a late metadata refresh must not
  // overwrite audio that finished caching between a separate read and write.
  await tx("readwrite", (store, fail) => {
    const request = store.get(key);
    request.onsuccess = () => {
      try {
        signal?.throwIfAborted();
        const existing = request.result;
        hadBlob = hasCachedAudio(existing);
        store.put(
          {
            ...existing,
            ...value,
            blob: value.blob ?? existing?.blob ?? null,
            content_type: value.content_type ?? existing?.content_type ?? value.track?.content_type ?? "",
            key,
            touched_at: Date.now(),
          },
          key,
        );
      } catch (error) { fail(error); }
    };
  }, { signal });
  // The transaction has committed before optional eviction/readback.
  // Callers can distinguish cancelling a write from cancelling its aftermath.
  onCommit?.();
  // Serialise eviction passes. Several player paths can finish at the same
  // time (active-track cache plus a prefetch), and concurrent trim scans used
  // to race and occasionally evict a record written by the other scan.
  if (hasIncomingBlob || !hadBlob) {
    trimPromise = trimPromise.catch(() => {}).then(() => trimCache());
    await waitForStorage(trimPromise, signal);
  }
  signal?.throwIfAborted();
  return getCachedTrack(key, { signal }).catch(error => { if (signal?.aborted) throw signal.reason; return null; });
}

export async function touchCachedTrack(key) {
  let item = null;
  await tx("readwrite", (store, fail) => {
    const request = store.get(key);
    request.onsuccess = () => {
      try {
        item = request.result || null;
        if (item) store.put({ ...item, touched_at: Date.now() }, key);
      } catch (error) { fail(error); }
    };
  });
  return item;
}

export function hasCachedAudio(item) {
  return item?.blob instanceof Blob && item.blob.size > 0;
}

async function hasNativeFlacFrames(blob) {
  const header = new Uint8Array(await blob.slice(0, 42).arrayBuffer());
  if (header.length !== 42 || header[0] !== 0x66 || header[1] !== 0x4c ||
      header[2] !== 0x61 || header[3] !== 0x43 || (header[4] & 0x7f) !== 0 ||
      header[5] !== 0 || header[6] !== 0 || header[7] !== 34) return false;
  const minBlock = (header[8] << 8) | header[9];
  const maxBlock = (header[10] << 8) | header[11];
  const sampleRate = (header[18] << 12) | (header[19] << 4) | (header[20] >> 4);
  const bitDepth = (((header[20] & 1) << 4) | (header[21] >> 4)) + 1;
  if (minBlock < 16 || maxBlock < minBlock || !sampleRate || bitDepth < 4 || bitDepth > 32) return false;
  let offset = 42;
  let last = Boolean(header[4] & 0x80);
  // Skip comments/artwork by length, reading only their four-byte headers.
  // Bound the number of reads and reject metadata-only/truncated objects.
  for (let block = 0; !last && block < 128; block++) {
    const next = new Uint8Array(await blob.slice(offset, offset + 4).arrayBuffer());
    if (next.length !== 4 || (next[0] & 0x7f) === 0 || (next[0] & 0x7f) === 127) return false;
    last = Boolean(next[0] & 0x80);
    offset += 4 + (next[1] << 16) + (next[2] << 8) + next[3];
    if (offset >= blob.size) return false;
  }
  if (!last) return false;
  const frame = new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer());
  return frame.length === 8 && frame[0] === 0xff && (frame[1] & 0xfe) === 0xf8 && !(frame[3] & 1);
}

/** Reuse an older complete FLAC without confusing it with ALAC packets. */
export async function reusableNativeFlacCache(item, requested, canPlayType = (type) =>
  typeof document !== "undefined" ? document.createElement("audio").canPlayType(type) : "") {
  if (!hasCachedAudio(item) || requested?.streaming_mode !== "wasm_alac") return null;
  const nativeRequest = { ...requested, streaming_mode: null };
  const key = cacheKey(nativeRequest);
  // Check the record as well as its key: an old/inconsistent metadata merge
  // must not make another song, quality, or packet Blob a native cache hit.
  if (!key || item.key !== key || !cacheEntryMatches(item, nativeRequest)) return null;
  const metadata = [item.task, item.track].filter(Boolean);
  if (!metadata.length || metadata.some((value) => cacheKey(value) !== key)) return null;
  // Some legacy tasks describe the original M4A although /audio returned
  // FLAC. Inspect the actual bytes; audio/mp4 alone cannot identify ALAC/AAC.
  if (!(await hasNativeFlacFrames(item.blob)) || !canPlayType("audio/flac")) return null;
  const representation = {
    streaming_mode: "", streaming_url: "", streaming_codec: "", streaming_protocol: "",
    format: "flac", content_type: "audio/flac", byte_size: item.blob.size, status: "completed",
  };
  return {
    ...item,
    // A Blob URL carries its Blob's MIME, which may also be stale in v1.
    blob: item.blob.type === "audio/flac" ? item.blob : item.blob.slice(0, item.blob.size, "audio/flac"),
    task: item.task ? { ...item.task, ...representation } : item.task,
    track: { ...(item.track || item.task), ...representation },
    content_type: "audio/flac",
    byte_size: item.blob.size,
  };
}

export function cachedAudioUrl(item) {
  if (!hasCachedAudio(item)) return "";
  return URL.createObjectURL(item.blob);
}

export function releaseCachedAudioUrl(url) {
  if (typeof url === "string" && url.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

/**
 * Download one complete audio object into IndexedDB.
 *
 * `signal` is used by the player for the active-track cache.  If the user
 * skips to another song while the cache is still being filled, aborting the
 * request is important: an orphaned full-file request can otherwise compete
 * with the new track's startup request for the same connection.
 */
export async function cacheAudioBlob(key, url, task, track, { signal, blob: completedBlob, priority = "low" } = {}) {
  if (!key || (!url && !completedBlob)) return null;
  if (signal?.aborted) {
    const error = new DOMException("音频缓存已取消", "AbortError");
    throw error;
  }
  const existing = await getCachedTrack(key).catch(() => null);
  if (hasCachedAudio(existing) && cacheEntryMatches(existing, task || track)) {
    await touchCachedTrack(key);
    return existing;
  }
  const activeDownload = activeAudioDownloads.get(key);
  if (activeDownload) {
    // Reuse a request owned by the same caller. If a previous active-track
    // request was aborted, wait for its cleanup and retry with the new signal
    // instead of returning its already-failed promise.
    if (activeDownload.signal === signal) return activeDownload.promise;
    try {
      await activeDownload.promise;
    } catch {
      // The next attempt below will create a fresh request.
    }
    if (signal?.aborted) {
      throw new DOMException("音频缓存已取消", "AbortError");
    }
    return cacheAudioBlob(key, url, task, track, { signal, blob: completedBlob, priority });
  }

  const download = (async () => {
    // The ALAC reader already owns a complete, validated packet stream at EOF.
    // Persist those bytes directly instead of opening a second full download.
    let blob = completedBlob;
    let contentType = blob?.type || "";
    if (!blob) {
      const response = await fetch(url, {
        cache: (task?.status || track?.status) === "completed" ? "default" : "no-store",
        credentials: "omit", priority, signal,
      });
      if (!response.ok) throw new Error(`音频本地缓存失败：HTTP ${response.status}`);
      blob = await response.blob();
      contentType = response.headers.get("content-type") || blob.type;
    }
    if (signal?.aborted) throw new DOMException("音频缓存已取消", "AbortError");
    if (!(blob instanceof Blob)) throw new Error("音频本地缓存失败：数据无效");
    if (!blob.size) throw new Error("音频本地缓存失败：文件为空");
    contentType ||= track?.content_type || "";
    if ((task?.streaming_mode || track?.streaming_mode) === "wasm_alac") {
      await validateAlacStreamBlob(blob, { signal });
      contentType = "application/x-splayer-alac";
    }
    if (signal?.aborted) throw new DOMException("音频缓存已取消", "AbortError");
    const readyTrack = {
      ...track,
      content_type: contentType,
      byte_size: blob.size,
      status: "completed",
    };
    return putCachedTrack(key, {
      task,
      track: readyTrack,
      blob,
      content_type: contentType,
      byte_size: blob.size,
      cached_audio_at: Date.now(),
    });
  })();

  const entry = { promise: download, signal };
  activeAudioDownloads.set(key, entry);
  try {
    return await download;
  } finally {
    if (activeAudioDownloads.get(key) === entry) activeAudioDownloads.delete(key);
  }
}

export function deleteCachedTrack(key, options) {
  return tx("readwrite", (store) => store.delete(key), options);
}

export async function listCachedTracks(options) {
  const records = await tx("readonly", store => store.getAll(), options);
  return records.filter(Boolean).sort((a, b) => (b.touched_at ?? 0) - (a.touched_at ?? 0));
}

export function clearCache() {
  return tx("readwrite", (store) => store.clear());
}

export async function trimCache(limit = LIMIT_BYTES) {
  const items = await listCachedTracks();
  let total = items.reduce((sum, item) => sum + (item.blob?.size ?? 0), 0);
  const ordered = [...items].sort((a, b) => (a.touched_at ?? 0) - (b.touched_at ?? 0));
  for (const item of ordered) {
    if (total <= limit) break;
    await deleteCachedTrack(item.key);
    total -= item.blob?.size ?? 0;
  }
}

/**
 * Return a cache entry only when its representation still matches the
 * requested transport. This guards older entries written before the WASM
 * packet stream was introduced: a caller that asks for wasm_alac must not
 * accidentally receive a legacy FLAC blob under a reused task id.
 */
export function cacheEntryMatches(item, task) {
  if (!item) return false;
  const requested = String(task?.streaming_mode || "").trim().toLowerCase();
  const trackMode = String(item.track?.streaming_mode || "").trim().toLowerCase();
  const taskMode = String(item.task?.streaming_mode || "").trim().toLowerCase();
  // Older versions inherited the requested WASM mode even when the backend
  // returned native audio. Reject both representations of that inconsistent
  // entry; otherwise refreshing metadata can disguise the incorrect Blob.
  if (item.task && item.track && "streaming_mode" in item.track && trackMode !== taskMode) return false;
  const stored = item.task ? taskMode : trackMode;
  if (requested === "wasm_alac") return stored === "wasm_alac";
  return stored !== "wasm_alac";
}

export function cacheStats(items) {
  const used = items.reduce((sum, item) => sum + (item.blob?.size ?? 0), 0);
  return {
    used,
    limit: LIMIT_BYTES,
    ratio: Math.min(1, used / LIMIT_BYTES),
  };
}
