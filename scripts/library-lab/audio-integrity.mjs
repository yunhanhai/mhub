import { OFFLINE_AUDIO_MAX_BYTES } from './download.mjs';

export const AUDIO_VERIFICATION_TIMEOUT_MS = 10000;
function wait(pending, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    // Blob reads and WebCrypto cannot be aborted. Consume their late failures,
    // while letting the caller leave without accepting a late successful hash.
    Promise.resolve(pending).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(signal.aborted ? signal.reason : error); });
  });
}
const integrityError = message => Object.assign(new Error(message), { offlineIntegrity: true });

// Both explicit saves and saved playback verify the complete immutable original.
export function createAudioVerifier({ timeoutMs = AUDIO_VERIFICATION_TIMEOUT_MS,
  readBlob = blob => blob.arrayBuffer(), digestImpl = bytes => crypto.subtle.digest('SHA-256', bytes) } = {}) {
  return async function verify(blob, { expectedBytes, sha256, signal } = {}) {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > OFFLINE_AUDIO_MAX_BYTES
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw integrityError('离线音频信息无效，请联网后重新保存。');
    if (!(blob instanceof Blob) || blob.size !== expectedBytes) throw integrityError('离线音频大小不匹配，请联网后重新保存。');
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('音频校验超时，请重试。', 'TimeoutError')), timeoutMs);
    try {
      const bytes = await wait(readBlob(blob), controller.signal);
      controller.signal.throwIfAborted();
      const result = await wait(digestImpl(bytes), controller.signal);
      controller.signal.throwIfAborted();
      const digest = [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, '0')).join('');
      if (digest !== sha256) throw integrityError('离线音频校验失败，请联网后重新保存。');
      return blob;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  };
}
