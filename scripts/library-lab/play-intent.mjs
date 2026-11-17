// A page has one current explicit playback intent. Repeating it reuses the same pending work.
export function createPlayIntents({ onChange = () => {} } = {}) {
  let current;
  const pending = new Set();
  return {
    run({ key, trackKey }, operation) {
      if (!key || !trackKey) return Promise.resolve(false);
      if (current?.key === key) return current.promise;
      current?.controller.abort(new DOMException('已选择其他播放操作', 'AbortError'));
      const controller = new AbortController();
      let resolve, reject;
      const work = new Promise((ok, failed) => { resolve = ok; reject = failed; });
      const entry = { key, trackKey, controller, promise: null };
      entry.promise = work.finally(() => {
        pending.delete(entry);
        if (current === entry) current = null;
        onChange();
      });
      current = entry; pending.add(entry); onChange();
      // Run synchronously so the player's native start keeps the click's user activation.
      try { Promise.resolve(operation(controller.signal)).then(resolve, reject); }
      catch (error) { reject(error); }
      return entry.promise;
    },
    state() { return current ? { key: current.key, trackKey: current.trackKey } : null; },
    get pendingCount() { return pending.size; },
    cancel() {
      const entry = current; current = null;
      if (entry) entry.controller.abort(new DOMException('播放操作已取消', 'AbortError'));
      onChange();
    },
  };
}
