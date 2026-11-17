// Download an explicit offline original with bounded bytes and cancellable idle/total deadlines.
export const OFFLINE_AUDIO_MAX_BYTES = 32 * 1024 * 1024;
export const OFFLINE_DOWNLOAD_IDLE_MS = 15000;
export const OFFLINE_DOWNLOAD_TOTAL_MS = 300000;

export function createOfflineAudioDownload({ fetchImpl = (...args) => fetch(...args), maxBytes = OFFLINE_AUDIO_MAX_BYTES,
  idleMs = OFFLINE_DOWNLOAD_IDLE_MS, totalMs = OFFLINE_DOWNLOAD_TOTAL_MS } = {}) {
  return async function download(url, { expectedBytes, contentType, signal, onProgress = () => {} } = {}) {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxBytes
      || !['audio/mpeg', 'audio/flac'].includes(contentType)) throw new Error('离线音频信息无效，请重新读取曲库。');
    const controller = new AbortController();
    let reader, response, idleTimer, totalTimer;
    // Remove each wait's listener when it settles. A single forever-pending
    // abort Promise would retain a reaction for every received chunk.
    const wait = pending => new Promise((resolve, reject) => {
      const abort = () => { controller.signal.removeEventListener('abort', abort); reject(controller.signal.reason); };
      if (controller.signal.aborted) abort();
      else controller.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(pending).then(value => {
        controller.signal.removeEventListener('abort', abort);
        if (controller.signal.aborted) reject(controller.signal.reason); else resolve(value);
      }, error => { controller.signal.removeEventListener('abort', abort); reject(controller.signal.aborted ? controller.signal.reason : error); });
    });
    const cancel = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new DOMException('离线下载长时间没有响应，请重试。', 'TimeoutError')), idleMs);
    };
    const cleanupBody = () => {
      try {
        if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        else if (response?.body) void response.body.cancel().catch(() => {});
      } catch { /* An already errored transport may have released its reader. */ }
    };
    try {
      resetIdle();
      totalTimer = setTimeout(() => controller.abort(new DOMException('离线下载用时过长，请重试。', 'TimeoutError')), totalMs);
      const fetching = Promise.resolve().then(() => fetchImpl(url, { signal: controller.signal, credentials: 'omit', cache: 'no-store' }));
      void fetching.then(value => {
        if (controller.signal.aborted && value?.body) { try { void value.body.cancel().catch(() => {}); } catch {} }
      }, () => {});
      response = await wait(fetching);
      controller.signal.throwIfAborted();
      if (response.status !== 200) throw new Error('离线保存失败：HTTP ' + response.status);
      const declaredType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (declaredType !== contentType) throw new Error('离线音频类型不匹配，请重试。');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expectedBytes)) throw new Error('离线音频大小不匹配，请重试。');
      reader = response.body?.getReader();
      if (!reader) throw new Error('离线音频内容为空，请重试。');
      const parts = []; let receivedBytes = 0;
      onProgress({ receivedBytes, totalBytes: expectedBytes });
      for (;;) {
        const { value, done } = await wait(reader.read());
        controller.signal.throwIfAborted();
        if (done) break;
        if (!value.byteLength) continue;
        // Reject before retaining an oversized chunk; never buffer beyond the trusted original length.
        if (receivedBytes + value.byteLength > expectedBytes) throw new Error('离线音频大小不匹配，请重试。');
        parts.push(value); receivedBytes += value.byteLength; resetIdle();
        onProgress({ receivedBytes, totalBytes: expectedBytes });
      }
      if (receivedBytes !== expectedBytes) throw new Error('离线音频下载不完整，请重试。');
      return new Blob(parts, { type: contentType });
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      if (!controller.signal.aborted) controller.abort(reason);
      if (reason instanceof TypeError) throw new Error('离线下载连接中断，请检查网络后重试。');
      throw reason;
    } finally {
      clearTimeout(idleTimer); clearTimeout(totalTimer);
      signal?.removeEventListener('abort', cancel);
      cleanupBody();
    }
  };
}
