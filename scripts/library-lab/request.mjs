// JSON control requests have their own bounds; media delivery keeps its separate lifecycle.
export function createLibraryRequest({ apiBase, clientHeader, fetchImpl = (...args) => fetch(...args),
  timeoutMs = 25000, maxBytes = 1024 * 1024 } = {}) {
  return async function request(url, { method = 'GET', data, signal, credentials = 'same-origin' } = {}) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('连接曲库超时，请重试。', 'TimeoutError')), timeoutMs);
    let response, reader;
    try {
      response = await fetchImpl(url.replace(/^\/api(?=\/)/, apiBase), { method, credentials,
        cache: 'no-store', signal: controller.signal,
        headers: { [clientHeader]: '1', ...(data ? { 'content-type': 'application/json' } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}) });
      controller.signal.throwIfAborted();
      if (!response.headers.get('content-type')?.match(/^\s*application\/(?:json|[\w.+-]+\+json)\s*(?:;|$)/i)) {
        throw Object.assign(new Error('曲库响应格式无效，请稍后重试。'), { kind: 'protocol', status: response.status });
      }
      if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new Error('曲库响应超过允许的大小，请重试。');
      reader = response.body?.getReader();
      if (!reader) throw new Error('曲库响应为空，请重试。');
      const parts = []; let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error('曲库响应超过允许的大小，请重试。');
        parts.push(value);
      }
      controller.signal.throwIfAborted();
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw Object.assign(new Error('曲库响应数据无效，请重试。'), { kind: 'protocol', status: response.status }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('曲库响应数据无效，请重试。');
      if (!response.ok) {
        const code = typeof body.error?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(body.error.code) ? body.error.code : '';
        throw Object.assign(new Error(typeof body.error?.message === 'string' ? body.error.message.slice(0, 500) : '曲库请求失败，请重试。'),
          { kind: 'http', status: response.status, code });
      }
      return body;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof TypeError) throw Object.assign(new Error('暂时无法连接曲库，请检查网络后重试。'), { kind: 'network' });
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      // Cleanup is best effort and must not extend the control request deadline.
      try {
        if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        else if (response?.body) void response.body.cancel().catch(() => {});
      } catch { /* A completed or errored body may already be released. */ }
    }
  };
}
