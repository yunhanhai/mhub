import { failedPlaybackTask } from './playback-recovery.mjs';

function wait(pending, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(signal.aborted ? signal.reason : error); });
  });
}
const protocolError = () => Object.assign(new Error('播放任务数据无效，请重试。'), { kind: 'protocol' });
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id);
function validate(task, id) {
  if (!task || task.id !== id || !['preparing', 'ready', 'failed', 'cancelled'].includes(task.state)) throw protocolError();
  return task;
}

export function createTaskPreparation({ request, ownTask, releaseTask,
  checkCurrent = (_epoch, signal) => signal?.throwIfAborted(), timeoutMs = 25000, pollMs = 100 }) {
  return async function readyTask(track, signal, epoch) {
    signal?.throwIfAborted();
    const controller = new AbortController(), cancel = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    // Creating and polling are one preparation, with no fresh budget per reply.
    const timer = setTimeout(() => controller.abort(new DOMException('准备音频超时，请重试。', 'TimeoutError')), timeoutMs);
    let ownedId;
    try {
      let task = await wait(request('/api/tasks', { method: 'POST', data: { instanceId: track.instanceId, songId: track.songId, version: track.version },
        signal: controller.signal }), controller.signal);
      if (!validId(task?.id)) throw protocolError();
      ownedId = task.id; ownTask(ownedId); checkCurrent(epoch, controller.signal); validate(task, ownedId);
      while (task.state === 'preparing') {
        let interval;
        try { await wait(new Promise(resolve => { interval = setTimeout(resolve, pollMs); }), controller.signal); }
        finally { clearTimeout(interval); }
        checkCurrent(epoch, controller.signal);
        const reply = await wait(request('/api/tasks/' + ownedId, { signal: controller.signal }), controller.signal);
        checkCurrent(epoch, controller.signal); task = validate(reply, ownedId);
      }
      if (task.state !== 'ready') throw failedPlaybackTask(task.error);
      return task;
    } catch (error) {
      // A malformed status must never replace the ID that this caller owns.
      if (ownedId) releaseTask(ownedId);
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  };
}
