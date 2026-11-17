// One local operation per immutable public representation. Web Locks coordinate cooperating tabs.
export function createOfflineOperations({ locks = globalThis.navigator?.locks, onChange = () => {} } = {}) {
  const entries = new Map();
  let generation = 0;
  function run(key, kind, operation) {
    const previous = entries.get(key);
    if (previous) {
      if (previous.kind === kind) return previous.promise;
      const epoch = generation;
      return previous.promise.catch(() => {}).then(() => {
        if (epoch !== generation) throw new DOMException('离线操作已取消', 'AbortError');
        return run(key, kind, operation);
      });
    }
    const controller = new AbortController();
    const entry = { kind, phase: 'waiting', controller, promise: null };
    const execute = async () => {
      controller.signal.throwIfAborted(); entry.phase = 'running'; onChange();
      return operation(controller.signal);
    };
    entry.promise = Promise.resolve().then(() => locks?.request
      ? locks.request('mhub-library-offline:' + key, { mode: 'exclusive', signal: controller.signal }, execute)
      : execute()).finally(() => {
      if (entries.get(key) === entry) entries.delete(key);
      onChange();
    });
    entries.set(key, entry); onChange();
    return entry.promise;
  }
  return {
    run,
    state(key) { const entry = entries.get(key); return entry ? { kind: entry.kind, phase: entry.phase } : null; },
    get size() { return entries.size; },
    cancel(key) {
      const entry = entries.get(key);
      if (!entry || entry.controller.signal.aborted) return false;
      entry.controller.abort(new DOMException('离线保存已取消', 'AbortError')); onChange(); return true;
    },
    cancelAll() { generation++; for (const entry of entries.values()) entry.controller.abort(); },
  };
}

// The player may revoke a handed-off URL itself. Sweeping also removes abandoned handoffs and tracking records.
export function createAudioUrlPool({ createUrl = blob => URL.createObjectURL(blob), revokeUrl = url => URL.revokeObjectURL(url),
  now = () => performance.now(), handoffMs = 1000 } = {}) {
  const entries = new Map();
  function release(url) { if (entries.delete(url)) revokeUrl(url); }
  return {
    create(blob) { const url = createUrl(blob); entries.set(url, now()); return url; },
    release,
    get size() { return entries.size; },
    sweep(attachedSources) {
      for (const [url, createdAt] of entries) if (!attachedSources.has(url) && now() - createdAt >= handoffMs) release(url);
    },
    clear() { for (const url of [...entries.keys()]) release(url); },
  };
}
