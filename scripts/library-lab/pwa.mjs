// Isolated /library/ app shell and user-controlled updates.
const ROOT = '/library/';
const WORKER = ROOT + 'sw.js';

function message(worker, data, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Worker response timed out')); }, timeout);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
    worker.postMessage(data, [channel.port2]);
  });
}

export function setupLibraryPwa({ canUpdate, onStatus }) {
  const status = document.getElementById('offline-shell-state');
  const install = document.getElementById('install-player');
  const update = document.getElementById('update-player');
  let registration, installPrompt, requestedUpdate = false;
  let waiting, activatedUpdate = false;
  const release = document.querySelector('meta[name="mhub-library-release"]')?.content || '';

  function waitingState() {
    if (waiting && waiting.state !== 'installed') waiting = null;
    const hidden = !waiting && !activatedUpdate;
    if (update.hidden !== hidden) update.hidden = hidden;
    if (hidden) return;
    const disabled = !canUpdate();
    if (update.disabled !== disabled) update.disabled = disabled;
    const text = disabled ? '暂停后可更新' : activatedUpdate ? '刷新到新版本' : '更新播放器';
    if (update.textContent !== text) update.textContent = text;
    const title = disabled ? '请先暂停播放，并等待保存操作完成。' : '保留已保存音乐，刷新到新版本。';
    if (update.title !== title) update.title = title;
  }

  async function shellState() {
    const worker = navigator.serviceWorker.controller;
    if (!worker || new URL(worker.scriptURL).pathname !== WORKER) return;
    try {
      const value = await message(worker, { type: 'LIBRARY_SHELL_STATUS' });
      status.textContent = '离线页面已准备好';
      onStatus?.({ ready: true, release: value.release });
      if (value.release !== release) { waiting = null; activatedUpdate = true; waitingState(); }
      if (value.release === release) worker.postMessage({ type: 'LIBRARY_PRUNE_SHELLS', release });
    } catch { status.textContent = '离线页面尚未准备好，请联网重试。'; }
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); installPrompt = event; install.hidden = false;
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; install.hidden = true; });
  install.onclick = async () => {
    if (!installPrompt) return;
    install.disabled = true;
    try { await installPrompt.prompt(); await installPrompt.userChoice; }
    finally { installPrompt = null; install.hidden = true; install.disabled = false; }
  };

  update.onclick = async () => {
    if (!canUpdate()) return;
    if (activatedUpdate) { location.reload(); return; }
    if (!waiting) return;
    requestedUpdate = true;
    update.disabled = true;
    try {
      const result = await message(waiting, { type: 'LIBRARY_ACTIVATE_UPDATE' }, 3500);
      if (!result.activated) {
        requestedUpdate = false;
        status.textContent = '其他曲库页面仍在播放或保存，请先暂停。';
        waitingState();
      }
    } catch {
      requestedUpdate = false;
      status.textContent = '暂时无法更新，请稍后重试。'; waitingState();
    }
  };

  if (!('serviceWorker' in navigator) || !window.isSecureContext || !location.pathname.startsWith(ROOT)) {
    status.textContent = '此页面尚不支持离线启动。';
    return { refresh: () => {} };
  }
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'LIBRARY_UPDATE_CHECK') event.ports[0]?.postMessage({ ready: canUpdate() });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (requestedUpdate && canUpdate()) { location.reload(); return; }
    if (requestedUpdate) { requestedUpdate = false; activatedUpdate = true; waitingState(); }
    void shellState();
  });

  async function register() {
    try {
      registration = await navigator.serviceWorker.register(WORKER, { scope: ROOT, updateViaCache: 'none' });
      waiting = registration.waiting;
      waitingState();
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        installing?.addEventListener('statechange', () => {
          if (['installed', 'activated', 'redundant'].includes(installing.state)) {
            waiting = registration.waiting;
            waitingState(); void shellState();
          }
        });
      });
      await navigator.serviceWorker.ready;
      await shellState();
    } catch { status.textContent = '离线页面准备失败，联网后可重试。'; onStatus?.({ ready: false }); }
  }
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => { void register(); }, { once: true });
  window.addEventListener('online', () => { registration?.update().catch(() => {}); });
  return { refresh: waitingState };
}
