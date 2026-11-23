import { createPinia, setActivePinia } from 'pinia';
import { watch } from 'vue';
import * as player from '../../frontend/src/core/player/index.js';
import { useStatusStore } from '../../frontend/src/stores/status.js';
import { useQueueStore } from '../../frontend/src/stores/queue.js';
import { useMediaStore } from '../../frontend/src/stores/media.js';
import { getCachedTrack, listCachedTracks, hasCachedAudio, deleteCachedTrack, putCachedTrack } from '../../frontend/src/services/localCache.js';
import { representationKey } from './identity.mjs';
import { iconMarkup, coverMarkup, formatDuration } from './presentation.mjs';
import { setupLibraryPwa } from './pwa.mjs';
import { createLibraryQueue, libraryTrackKey } from './queue.mjs';
import { createArtworkCache } from './artwork.mjs';
import { BROWSE_PAGE_SIZE, albumChoices, browseTracks, safeBrowseSort } from './browse.mjs';
import { createAudioUrlPool, createOfflineOperations } from './operations.mjs';
import { createLibraryRequest } from './request.mjs';
import { createOfflineAudioDownload } from './download.mjs';
import { createPlayIntents } from './play-intent.mjs';
import { createSeekInput } from './seek.mjs';
import { playbackRecovery, failedPlaybackTask } from './playback-recovery.mjs';

setActivePinia(createPinia());
const status = useStatusStore(), queue = useQueueStore(), media = useMediaStore();
// Song metadata stays in this isolated page; the combined app retains its own queue storage.
queue.save = () => {};
status.persist = () => {};
status.quality = 'raw'; status.volume = .35; status.repeatMode = 'off';
status.shuffleMode = 'off'; status.speed = 1;
status.crossfadeEnabled = false; status.soundCheckEnabled = false; status.autoplayEnabled = false;
const queueControl = createLibraryQueue({ player, queue, status });
const $ = id => document.getElementById(id);
function setText(element, value) { if (element.textContent !== value) element.textContent = value; }
function setProperty(element, name, value) { if (element[name] !== value) element[name] = value; }
function setAttribute(element, name, value) {
  if (value === null) { if (element.hasAttribute(name)) element.removeAttribute(name); }
  else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}
function setClass(element, name, enabled) { if (element.classList.contains(name) !== enabled) element.classList.toggle(name, enabled); }
const apiBase = document.querySelector('meta[name="mhub-library-api"]')?.content || '/api';
const clientHeader = apiBase === '/api' ? 'x-library-lab' : 'x-mhub-library';
const audio = document.createElement('audio');
audio.preload = 'auto'; audio.crossOrigin = 'anonymous'; document.body.append(audio);
let user = null, instanceId = '', generation = 0, searchGeneration = 0;
let sessionState = 'checking', sessionError = '', sessionRevision = 0, sessionController, sessionMethod = 'GET';
try { instanceId = localStorage.getItem('library-lab-instance') || ''; } catch {}
let tracks = [], offline = [], changingIdentity = false, queueOperationCount = 0, playbackAction = 0;
let playbackFailure = null, retryingPlaybackKey = '', retryFocused = false;
let retryRevision = 0;
let catalogueRecovery = null;
let catalogue = [], catalogueReady = false, catalogueError = '', catalogueController;
let visibleCount = BROWSE_PAGE_SIZE, searchInputTimer, searchComposing = false;
let savedOnly = false, formatFilter = '', albumFilter = '', albumSignature = '';
let browseSort = 'source';
try { browseSort = safeBrowseSort(localStorage.getItem('mhub-library-sort')); } catch {}
let libraryOffline = !navigator.onLine;
let offlineReadState = 'loading';
const pending = new Set();
const audioUrls = createAudioUrlPool();
const saveTransfers = new Map();
const trackRows = new WeakMap();
const queueRows = new WeakMap();
let renderedQueueState = '';
const playIntents = createPlayIntents({ onChange: () => { syncPlaybackButtons(); renderQueue(); } });
const storageOperations = createOfflineOperations({ onChange: () => { syncOfflineButtons(); renderSaveTransfers(); } });
const downloadOfflineAudio = createOfflineAudioDownload();
const storageChannel = new BroadcastChannel('mhub-library-offline');
const taskResources = new Map();
let offlineRefreshId = 0;
const playbackControllers = new Set();
const verifiedBlobs = new WeakSet();
const channel = new BroadcastChannel('library-lab-session');
const keyFor = track => representationKey(track.instanceId, track.songId, track.version);
const select = track => ({ instanceId: track.instanceId, songId: track.songId, version: track.version });
const request = createLibraryRequest({ apiBase, clientHeader });
// The shared player reports transport failures through these store actions.
// Route them to this page's visible player feedback without changing its core.
const setPlayerNotice = status.setNotice.bind(status);
status.setNotice = message => {
  setPlayerNotice(message);
  if (message === '音频已就绪，点击播放') reportPlaybackFailure('音频已就绪，请点击播放以允许浏览器播放声音。', 'permission');
};
status.toast = message => { setPlayerNotice(message); reportPlaybackFailure(message); };
const artworkCache = createArtworkCache({ apiBase, keyFor, cachedTrack: getCachedTrack, isOffline: () => libraryOffline });
function renderCover(element, track) {
  const key = libraryTrackKey(track) + ':' + (track?.artwork?.sha256 || '') + ':' + (track?.access || ''); element.dataset.coverKey = key;
  element.innerHTML = coverMarkup(track); element.title = '占位封面';
  void artworkCache.get(track).then(value => {
    if (!value || element.dataset.coverKey !== key || !element.isConnected) return;
    const image = document.createElement('img'); image.src = value.url; image.alt = ''; image.decoding = 'async';
    element.replaceChildren(image); element.title = track.album ? '专辑封面：' + track.album : '曲目封面';
  });
}
function iconButtonContent(button, name, label) {
  const key = name + ':' + label;
  if (button.dataset.presentation === key) return;
  button.dataset.presentation = key;
  button.innerHTML = iconMarkup(name);
  const text = document.createElement('span'); text.className = 'sr-only'; text.textContent = label; button.append(text);
  button.setAttribute('aria-label', label); button.title = label;
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  iconButtonContent($('theme-toggle'), theme === 'dark' ? 'sun' : 'moon', theme === 'dark' ? '切换到明亮主题' : '切换到深色主题');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101914' : '#f2f5ef');
}
applyTheme(document.documentElement.dataset.theme || 'dark');
$('theme-toggle').onclick = () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme); try { localStorage.setItem('mhub-library-theme', theme); } catch {}
};
function navigationState() {
  const target = location.hash || '#library-content';
  for (const link of document.querySelectorAll('.nav-link')) {
    const active = link.hash === target;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', navigationState);
navigationState();
function keepFocusedControlVisible() {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || !element.getClientRects().length) return;
  const sidebar = element.closest('.sidebar');
  if (!element.closest('main') && !sidebar) return;
  const rect = element.getBoundingClientRect(), playerTop = document.querySelector('.player').getBoundingClientRect().top;
  const fixedSidebar = sidebar && getComputedStyle(sidebar).position === 'fixed';
  const boundary = fixedSidebar ? sidebar.getBoundingClientRect() : null;
  const safeTop = boundary ? boundary.top + 12 : 16;
  const safeBottom = Math.min(innerHeight, playerTop, boundary ? boundary.bottom : innerHeight) - 12;
  const offset = rect.top < safeTop ? rect.top - safeTop : rect.bottom > safeBottom ? rect.bottom - safeBottom : 0;
  if (Math.abs(offset) > .5) (fixedSidebar ? sidebar : window).scrollBy({ top: offset, behavior: 'instant' });
}
document.addEventListener('focusin', keepFocusedControlVisible);
window.addEventListener('resize', keepFocusedControlVisible);
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function currentAudioIsPlaying() {
  let source;
  try { source = new URL(status.currentSource, location.href).href; } catch { return false; }
  return status.state === 'playing' && Boolean(status.currentSource) && [...document.querySelectorAll('audio')]
    .some(element => !element.paused && !element.ended && !element.error && (element.currentSrc || element.src) === source);
}
function reportPlaybackFailure(message, kind = 'error', cause) {
  const key = libraryTrackKey(media.track); if (!key) return;
  const text = String(message || '音频未能开始播放，请重试。').slice(0, 240);
  const same = playbackFailure?.key === key && playbackFailure.epoch === generation && playbackFailure.kind === kind && playbackFailure.message === text;
  const recovery = !cause && same ? playbackFailure : playbackRecovery(cause);
  playbackFailure = { ...recovery, key, epoch: generation, message: text, kind,
    songId: media.track.songId, instanceId: media.track.instanceId };
  renderPlaybackFeedback();
}
function renderPlaybackFeedback() {
  const key = libraryTrackKey(media.track);
  if (playbackFailure && (playbackFailure.key !== key || playbackFailure.epoch !== generation || currentAudioIsPlaying())) playbackFailure = null;
  const visible = Boolean(playbackFailure);
  const panel = $('playback-feedback'), message = $('playback-message'), button = $('retry-playback');
  if (!panel) return;
  setProperty(panel, 'hidden', !visible);
  if (visible) {
    const refreshing = catalogueRecovery?.key === key;
    const busy = refreshing || retryingPlaybackKey === key || status.trackLoading;
    const text = refreshing ? '正在刷新曲库，请稍候。' : busy ? '正在重新准备音频，请稍候。'
      : playbackFailure.message + (playbackFailure.refreshed ? ' 曲库已刷新，请从列表重新选择曲目。'
        : playbackFailure.refreshError ? ' ' + playbackFailure.refreshError : '');
    if (message.textContent !== text) message.textContent = text;
    const label = refreshing ? '正在刷新…' : busy ? '正在重试…' : playbackFailure.kind === 'permission' ? '允许播放'
      : playbackFailure.recovery === 'identity' ? playbackFailure.code === 'instance_missing' ? '重新连接曲库' : '重新确认账号'
      : playbackFailure.recovery === 'catalogue' ? playbackFailure.refreshed ? '选择曲目' : '刷新曲库' : '重试播放';
    if (button.textContent !== label) button.textContent = label;
    setProperty(button, 'disabled', busy || changingIdentity);
    setAttribute(button, 'aria-busy', busy ? 'true' : null);
  } else {
    setText(message, ''); setAttribute(button, 'aria-busy', null);
    if (retryFocused && (document.activeElement === button || document.activeElement === document.body)) $('transport').focus({ preventScroll: true });
    retryFocused = false;
  }
  const preparing = status.trackLoading || Boolean(key && retryingPlaybackKey === key) || Boolean(playIntents.state()) || Boolean(catalogueRecovery);
  setText($('player-state'), catalogueRecovery ? '正在刷新曲库' : preparing ? '正在准备' : playbackFailure ? playbackFailure.kind === 'permission'
    ? '等待允许播放' : playbackFailure.refreshed ? '请重新选择曲目' : '播放未能开始'
    : ({ playing: '正在播放', buffering: '正在缓冲', paused: '已暂停', stopped: '已停止', idle: '尚未播放' }[status.state] || status.state));
  const wantsPlay = status.isPlaying || preparing;
  iconButtonContent($('transport'), wantsPlay ? 'pause' : 'play', wantsPlay ? '暂停' : '播放');
  setProperty($('transport'), 'disabled', !media.track);
  syncPlaybackButtons();
}
watch(() => [libraryTrackKey(media.track), status.state, status.trackLoading, status.currentSource], renderPlaybackFeedback, { flush: 'post' });
const playerResize = new ResizeObserver(entries => {
  document.documentElement.style.setProperty('--library-player-height', Math.ceil(entries[0].target.getBoundingClientRect().height) + 'px');
  keepFocusedControlVisible();
});
playerResize.observe(document.querySelector('.player'));
function begin() { const controller = new AbortController(); pending.add(controller); return controller; }
function current(epoch, signal) { if (epoch !== generation || signal?.aborted) throw new DOMException('操作已取消', 'AbortError'); }
function releaseTask(id) {
  if (!taskResources.delete(id)) return;
  void fetch(apiBase + '/tasks/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin', cache: 'no-store',
    headers: { [clientHeader]: '1' }, signal: AbortSignal.timeout(2500), keepalive: true }).catch(() => {});
}
function cancelPlaybackRequests() { for (const controller of playbackControllers) controller.abort(); }
function attachedAudioSources() {
  const sources = new Set(status.currentSource ? [status.currentSource] : []);
  for (const element of document.querySelectorAll('audio[src]')) { if (element.src) sources.add(element.src); if (element.currentSrc) sources.add(element.currentSrc); }
  return sources;
}
function sweepPlaybackResources() {
  const sources = attachedAudioSources(); audioUrls.sweep(sources);
  for (const [id, task] of taskResources) if (!task.held && !sources.has(task.source) && performance.now() - task.deliveredAt >= 1000) releaseTask(id);
}
function invalidate(stopAudio = true, resetBrowse = true) {
  generation++; searchGeneration++;
  cancelCatalogueRecovery();
  playIntents.cancel(); retryRevision++;
  playbackFailure = null; retryingPlaybackKey = ''; retryFocused = false; renderPlaybackFeedback();
  offlineRefreshId++;
  storageOperations.cancelAll();
  for (const transfer of saveTransfers.values()) clearTimeout(transfer.uiTimer);
  saveTransfers.clear(); renderSaveTransfers();
  clearTimeout(searchInputTimer);
  artworkCache.invalidate(!stopAudio);
  for (const c of pending) c.abort(); pending.clear();
  for (const id of [...taskResources.keys()]) releaseTask(id);
  if (stopAudio) {
    player.stop(); player.clearQueue(); media.setTrack(null);
    audioUrls.clear();
    renderCover($('player-art'), { songId: 'welcome' });
  }
  catalogue = []; catalogueReady = false; catalogueError = '';
  albumSignature = '';
  const allAlbums = document.createElement('option'); allAlbums.value = ''; allAlbums.textContent = '全部专辑';
  $('filter-album').replaceChildren(allAlbums);
  if (resetBrowse) {
    $('query').value = ''; formatFilter = ''; albumFilter = ''; savedOnly = false;
    $('filter-format').value = ''; $('filter-album').value = ''; $('filter-saved').checked = false;
  }
  visibleCount = BROWSE_PAGE_SIZE; tracks = []; renderTracks();
  renderQueue();
}
function publicBlobIsAttached() {
  return media.track?.access === 'public' && status.currentSource?.startsWith('blob:')
    && [...document.querySelectorAll('audio')].some(element => (element.currentSrc || element.src) === status.currentSource && element.hasAttribute('src'));
}
function storageReadFailed() {
  offlineReadState = 'unavailable'; offline = [];
  savedOnly = false; $('filter-saved').checked = false;
  if (libraryOffline) queueControl.restrictOffline([], publicBlobIsAttached());
  renderOffline(); if (catalogueReady || libraryOffline) applyBrowse();
}
function storageAccessError() { return new Error('本地音频存储暂时不可用，请在“离线保存”中重试读取。'); }
async function cached(track, signal) {
  if (track.access !== 'public' || !track.offlineAllowed || track.instanceId !== instanceId) return null;
  const epoch = generation;
  let item;
  try { item = await getCachedTrack(keyFor(track), { signal }); }
  catch (error) {
    current(epoch, signal);
    if (signal?.aborted || error.name === 'AbortError') throw error;
    storageReadFailed(); throw storageAccessError();
  }
  current(epoch, signal);
  if (!hasCachedAudio(item) || item.track?.access !== 'public' || !item.track?.offlineAllowed || keyFor(item.track) !== keyFor(track)) return null;
  if (item.blob.size !== track.byte_size) throw Object.assign(new Error('离线音频大小不匹配，请联网后重新保存。'), { offlineIntegrity: true });
  if (!verifiedBlobs.has(item.blob)) {
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await item.blob.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== track.version) throw Object.assign(new Error('离线音频校验失败，请联网后重新保存。'), { offlineIntegrity: true });
    verifiedBlobs.add(item.blob);
  }
  return item;
}
async function cachedSource(track, signal) {
  const epoch = generation;
  if (!libraryOffline && offlineReadState !== 'ready') return null;
  let item;
  try { item = await cached(track, signal); }
  catch (error) {
    current(epoch, signal);
    if (libraryOffline) throw error;
    return null;
  }
  current(epoch, signal);
  if (!item) return null;
  const artwork = await Promise.race([artworkCache.get(track), new Promise(resolve => setTimeout(() => resolve(null), 180))]); current(epoch, signal);
  const source = audioUrls.create(item.blob);
  return { source, track: { ...track, cover: artwork?.url || '', status: 'completed' } };
}
async function readyTask(track, signal, epoch) {
  let task;
  try {
    task = await request('/api/tasks', { method: 'POST', data: select(track), signal });
    if (typeof task.id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(task.id)) throw new Error('播放任务数据无效');
    taskResources.set(task.id, { source: null, held: true, deliveredAt: performance.now() });
    current(epoch, signal);
    const deadline = Date.now() + 25000;
    while (task.state === 'preparing') {
      if (Date.now() > deadline) throw new Error('准备音频超时，请重试');
      await new Promise(resolve => setTimeout(resolve, 100)); current(epoch, signal);
      task = await request('/api/tasks/' + task.id, { signal }); current(epoch, signal);
    }
    if (task.state !== 'ready') throw failedPlaybackTask(task.error);
    return task;
  } catch (error) {
    if (task?.id) releaseTask(task.id);
    throw error;
  }
}
player.initPlayer({ audio,
  resolveTrackSource: async track => {
    cancelPlaybackRequests();
    const epoch = generation, controller = begin();
    playbackControllers.add(controller);
    let task;
    try {
      const local = await cachedSource(track, controller.signal); current(epoch, controller.signal);
      if (local) return local;
      if (libraryOffline) throw new Error('这首曲目没有离线副本，请联网后播放。');
      task = await readyTask(track, controller.signal, epoch);
      const artwork = await Promise.race([artworkCache.get(task.track), new Promise(resolve => setTimeout(() => resolve(null), 180))]); current(epoch, controller.signal);
      Object.assign(taskResources.get(task.id), { source: task.mediaUrl, held: false, deliveredAt: performance.now() });
      return { source: task.mediaUrl, track: { ...task.track, cover: artwork?.url || '', status: 'completed', playback_id: task.id } };
    } catch (error) {
      if (task?.id) releaseTask(task.id);
      if (epoch === generation && !controller.signal.aborted && error?.name !== 'AbortError'
        && libraryTrackKey(media.track) === libraryTrackKey(track)) reportPlaybackFailure(error.message, 'error', error);
      throw error;
    } finally { pending.delete(controller); playbackControllers.delete(controller); }
  },
  resolveCachedTrackSource: cachedSource,
  // Explicit offline saves only. This slice has no speculative next-track fetch.
  cacheActiveTrackSource: async track => { try { return Boolean(await cached(track)); } catch { return false; } },
  prefetchTrackSource: async () => false,
  loadLyricsForTrack: async () => [],
});
async function refreshOffline() {
  const revision = ++offlineRefreshId, epoch = generation, expectedInstance = instanceId;
  let records;
  try { records = await listCachedTracks(); }
  catch {
    if (revision === offlineRefreshId && epoch === generation && expectedInstance === instanceId) storageReadFailed();
    return false;
  }
  if (revision !== offlineRefreshId || epoch !== generation || expectedInstance !== instanceId) return false;
  offlineReadState = 'ready';
  offline = records.filter(item => item.key?.startsWith('library-lab:') && item.track?.instanceId === expectedInstance
    && item.track?.access === 'public' && item.track?.offlineAllowed && keyFor(item.track) === item.key && hasCachedAudio(item));
  renderOffline();
  if (libraryOffline) {
    queueControl.restrictOffline(offline.map(item => item.track), publicBlobIsAttached());
    applyBrowse();
  } else if (catalogueReady) {
    applyBrowse();
  }
  return true;
}
function renderOffline() {
  renderTrackRows($('offline-tracks'), offline.map(item => item.track), true, $('offline-heading'));
  syncOfflineButtons();
  const unavailable = offlineReadState === 'unavailable';
  $('offline-state').textContent = unavailable ? '此浏览器的离线副本暂时无法读取。' : offline.length ? `${offline.length} 首公开曲目已保存在此浏览器` : '保存公开曲目后，断网也可以重新打开播放。';
  const usedBytes = offline.reduce((sum, item) => sum + item.blob.size, 0);
  $('offline-storage').textContent = unavailable ? '存储占用暂时无法读取。' : usedBytes ? `音频副本占用 ${(usedBytes / 1024 / 1024).toFixed(2)} MiB` : '还没有占用音频存储空间。';
  $('offline-error').hidden = !unavailable;
  $('offline-error').textContent = unavailable ? libraryOffline ? '请重试读取；恢复联网后仍可在线收听。' : '联网仍可播放曲目，请重试读取离线副本。' : '';
  $('retry-offline').hidden = !unavailable;
  $('filter-saved').disabled = libraryOffline || unavailable;
  if (unavailable) return;
  if (!offline.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.innerHTML = iconMarkup('download');
    const title = document.createElement('strong'); title.textContent = '把喜欢的音乐留下来';
    const detail = document.createElement('span'); detail.textContent = '联网时点击曲目旁的“保存离线”，下次断网也能重新打开收听。';
    empty.append(title, detail); $('offline-tracks').append(empty);
  }
}
$('retry-offline').onclick = () => {
  const button = $('retry-offline'), hadFocus = document.activeElement === button;
  button.disabled = true; button.textContent = '正在读取…'; button.setAttribute('aria-busy', 'true');
  void refreshOffline().then(ok => { if (ok) notice('离线副本已重新读取。'); }).finally(() => {
    button.disabled = false; button.textContent = '重试读取'; button.removeAttribute('aria-busy');
    if (button.hidden && hadFocus && (document.activeElement === button || document.activeElement === document.body)) $('offline-heading').focus({ preventScroll: true });
  });
};
function handleError(error) {
  if (error?.name !== 'AbortError') notice(error?.name === 'QuotaExceededError'
    ? '浏览器存储空间不足，请腾出空间后重新保存。' : error.message || '操作失败', true);
}
function runPlayback(action, track, { intentKey = 'select:' + libraryTrackKey(track), retry = false } = {}) {
  const trackKey = libraryTrackKey(track);
  if (changingIdentity || !trackKey) return Promise.resolve(false);
  if (catalogueRecovery?.key === trackKey) return Promise.resolve(false);
  if (catalogueRecovery) cancelCatalogueRecovery();
  // Natural continuation also owns its pending source, even without an explicit page action.
  if (!playIntents.state() && status.trackLoading && libraryTrackKey(media.track) === trackKey) return Promise.resolve(false);
  const epoch = generation, title = track.title;
  const focused = document.activeElement;
  const container = focused?.dataset.playKey === trackKey ? focused.closest('#offline-tracks, #results') : null;
  const listFocus = container ? trackListFocus(container, container.id === 'results' ? $('catalogue-heading') : $('offline-heading')) : null;
  const queueFocus = focused?.dataset.queueKey === trackKey && focused.dataset.queueAction === 'play';
  let ownedSignal;
  const result = playIntents.run({ key: intentKey, trackKey }, async signal => {
    ownedSignal = signal;
    const cancelled = () => cancelPlaybackRequests();
    signal.addEventListener('abort', cancelled, { once: true });
    cancelPlaybackRequests();
    if (!retry) { retryRevision++; retryingPlaybackKey = ''; }
    const actionId = ++playbackAction;
    queueOperationCount++; renderQueue(); notice('正在准备 ' + title);
    try {
      const ok = await action(); current(epoch, signal);
      if (actionId !== playbackAction) return false;
      renderPlaybackFeedback();
      if (currentAudioIsPlaying()) notice('正在播放 ' + (media.track?.title || title));
      else if (playbackFailure) notice(playbackFailure.message, playbackFailure.kind === 'error');
      else if (status.trackLoading) notice('正在准备 ' + title);
      else if (status.state === 'buffering') notice('正在缓冲 ' + title);
      else if (!ok && status.state === 'paused') { notice('已暂停，准备操作已取消。'); return false; }
      else { reportPlaybackFailure('音频未能开始播放，请重试。'); notice(playbackFailure.message, true); }
      return ok;
    } finally { signal.removeEventListener('abort', cancelled); queueOperationCount--; renderQueue(); }
  });
  return result.finally(() => {
    renderPlaybackFeedback();
    if (!ownedSignal || ownedSignal.aborted || epoch !== generation) return;
    restoreTrackListFocus(listFocus);
    if (queueFocus && (document.activeElement === focused || document.activeElement === document.body)) {
      const replacement = [...$('playback-queue').querySelectorAll('.queue-play')].find(button => button.dataset.queueKey === trackKey && !button.disabled);
      (replacement || $('queue-heading')).focus({ preventScroll: true }); keepFocusedControlVisible();
    }
  });
}
async function playTrack(track) {
  if (libraryTrackKey(media.track) !== libraryTrackKey(track)) { playbackFailure = null; renderPlaybackFeedback(); }
  return runPlayback(() => queueControl.play(track, tracks.some(item => libraryTrackKey(item) === libraryTrackKey(track)) ? tracks : [track]), track);
}
function retryCurrentPlayback() {
  if (changingIdentity || status.trackLoading || retryingPlaybackKey || !media.track) return;
  if (catalogueRecovery) return;
  if (playbackFailure?.recovery === 'identity') { recoverPlaybackIdentity(); return; }
  if (playbackFailure?.recovery === 'catalogue') {
    if (playbackFailure.refreshed) focusRecoveredCatalogue(playbackFailure);
    else recoverPlaybackCatalogue();
    return;
  }
  const key = libraryTrackKey(media.track), title = media.track.title;
  const revision = ++retryRevision;
  const renewSource = playbackFailure?.kind === 'error';
  retryingPlaybackKey = key; renderPlaybackFeedback();
  if (renewSource) player.stop();
  void runPlayback(() => player.play(), media.track, { retry: true }).catch(handleError).finally(() => {
    if (revision === retryRevision) retryingPlaybackKey = '';
    renderPlaybackFeedback();
  });
}
$('retry-playback').onclick = () => { retryFocused = document.activeElement === $('retry-playback'); retryCurrentPlayback(); };
function recoveryFocusStillOwned(focus) { return document.activeElement === focus || document.activeElement === document.body; }
function focusRecoveredCatalogue(failure) {
  const row = [...$('results').children].find(node => {
    const track = trackRows.get(node)?.track;
    return track?.instanceId === failure.instanceId && track.songId === failure.songId;
  });
  const button = row?.querySelector('.play-track');
  (button && !button.disabled ? button : $('catalogue-heading')).focus({ preventScroll: true }); keepFocusedControlVisible();
}
function recoverPlaybackIdentity() {
  const focus = document.activeElement; retryFocused = false;
  const action = syncIdentity(true, true), revision = sessionRevision;
  void action.then(() => {
    // The same session response may legitimately change the instance generation.
    if (revision !== sessionRevision || !recoveryFocusStillOwned(focus)) return;
    const target = sessionState === 'unavailable' ? $('retry-session') : !user && !libraryOffline ? $('username') : $('identity');
    target.focus({ preventScroll: true }); keepFocusedControlVisible();
  }).catch(handleError);
}
function cancelCatalogueRecovery() {
  if (!catalogueRecovery) return;
  const action = catalogueRecovery; catalogueRecovery = null;
  action.controller?.abort(); retryFocused = false;
  renderPlaybackFeedback();
}
function recoverPlaybackCatalogue() {
  if (sessionState !== 'ready' || libraryOffline) { recoverPlaybackIdentity(); return; }
  const failure = playbackFailure, focus = document.activeElement;
  const action = { key: failure.key, epoch: generation, failure, controller: null };
  catalogueRecovery = action; retryFocused = false;
  player.stop(); renderPlaybackFeedback();
  const refresh = search(); action.controller = catalogueController;
  void refresh.then(() => {
    if (catalogueRecovery !== action || action.epoch !== generation || action.controller?.signal.aborted || playbackFailure !== failure) return;
    playbackFailure = { ...failure, refreshed: true, refreshError: '' }; action.outcome = 'select';
  }).catch(error => {
    if (catalogueRecovery !== action || action.epoch !== generation || error?.name === 'AbortError') return;
    playbackFailure = { ...failure, refreshError: String(error.message || '曲库刷新失败，请重试。').slice(0, 240) }; action.outcome = 'retry';
    notice(error.message || '曲库刷新失败，请重试。', true);
  }).finally(() => {
    if (catalogueRecovery !== action) return;
    catalogueRecovery = null; renderPlaybackFeedback();
    if (action.epoch !== generation || playbackFailure?.key !== action.key || !recoveryFocusStillOwned(focus)) return;
    if (action.outcome === 'select') focusRecoveredCatalogue(failure);
    else if (action.outcome === 'retry') { $('retry-playback').focus({ preventScroll: true }); keepFocusedControlVisible(); }
  });
}
function appendTracks(items) {
  if (changingIdentity) return;
  const count = queueControl.append(items); renderQueue();
  notice(count ? `已追加 ${count} 首，当前播放保持不变。` : '这些曲目已在队列中。');
}
function nextTracks(items) {
  if (changingIdentity) return;
  const count = queueControl.next(items); renderQueue();
  notice(count ? '已安排下一首。' : '当前曲目已在队列中，无需再次安排。');
}
function announceOfflineChange(expectedInstance = instanceId) { storageChannel.postMessage({ type: 'changed', instanceId: expectedInstance }); }
async function saveOffline(track) {
  if (track.access !== 'public' || !track.offlineAllowed) throw new Error('受限曲目不能保存离线副本');
  if (libraryOffline) throw new Error('当前离线，请联网后保存新曲目。');
  const epoch = generation;
  const key = keyFor(track);
  let transfer = saveTransfers.get(key);
  if (!transfer) {
    const focused = document.activeElement;
    const container = focused?.dataset.offlineKey === key ? focused.closest('#offline-tracks, #results') : null;
    transfer = { epoch, title: track.title, phase: 'waiting', receivedBytes: 0, totalBytes: track.byte_size, cancelled: false, wrote: false,
      uiAt: -Infinity, uiTimer: null, returnFocus: false,
      rowFocus: container ? trackListFocus(container, container.id === 'results' ? $('catalogue-heading') : $('offline-heading')) : null };
    saveTransfers.set(key, transfer);
  }
  const draw = () => {
    clearTimeout(transfer.uiTimer); transfer.uiTimer = null;
    if (saveTransfers.get(key) !== transfer || epoch !== generation) return;
    transfer.uiAt = performance.now(); syncOfflineButtons(); renderSaveTransfers();
  };
  const update = (values, progressOnly = false) => {
    if (saveTransfers.get(key) !== transfer || epoch !== generation) return;
    Object.assign(transfer, values);
    if (progressOnly && transfer.receivedBytes < transfer.totalBytes && performance.now() - transfer.uiAt < 120) {
      if (!transfer.uiTimer) transfer.uiTimer = setTimeout(draw, 120);
    } else draw();
  };
  return storageOperations.run(key, 'save', async signal => {
    let task, wrote = false, refreshed = false;
    try {
      current(epoch, signal);
      update({ phase: 'checking' });
      let existing;
      try { existing = await cached(track, signal); } catch (error) { if (!error.offlineIntegrity) throw error; existing = null; }
      current(epoch, signal);
      if (existing) { await refreshOffline(); current(epoch, signal); notice('已保存 ' + track.title); return; }
      notice('正在保存 ' + track.title);
      update({ phase: 'preparing' });
      task = await readyTask(track, signal, epoch);
      if (!task.track.offlineAllowed || task.track.access !== 'public') throw new Error('离线保存权限已变化');
      update({ phase: 'downloading' });
      const blob = await downloadOfflineAudio(task.mediaUrl, { signal, expectedBytes: track.byte_size, contentType: task.track.content_type,
        onProgress: progress => update({ ...progress, phase: 'downloading' }, true) });
      current(epoch, signal); update({ phase: 'verifying' });
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(v => v.toString(16).padStart(2, '0')).join('');
      current(epoch, signal);
      if (blob.size !== track.byte_size || digest !== track.version) throw new Error('离线音频校验失败');
      const ready = { ...task.track, status: 'completed' };
      update({ phase: 'writing' });
      // These bytes were verified above. Replace a damaged same-key record instead of reusing it by MIME alone.
      const stored = await putCachedTrack(keyFor(track), { task: ready, track: ready, blob,
        content_type: ready.content_type, byte_size: blob.size, cached_audio_at: Date.now() }, { signal });
      if (!hasCachedAudio(stored) || stored.blob.size !== track.byte_size) throw new Error('本地存储未能保留音频，请腾出空间后重试。');
      wrote = true; update({ wrote: true, phase: 'finishing' });
      current(epoch, signal);
      const artwork = await artworkCache.get(ready); current(epoch, signal);
      await putCachedTrack(keyFor(track), { track: ready, ...(artwork ? { artwork_blob: artwork.blob } : {}) }, { signal });
      current(epoch, signal); await refreshOffline(); refreshed = true; current(epoch, signal); notice('已保存 ' + track.title);
    } finally {
      if (task?.id) releaseTask(task.id);
      if (wrote) {
        announceOfflineChange(track.instanceId);
        // This page does not receive its own BroadcastChannel message. A
        // cancelled metadata write must still reveal the committed audio here.
        if (!refreshed && epoch === generation) await refreshOffline();
      }
    }
  }).catch(error => {
    if (transfer.cancelled && error.name === 'AbortError' && epoch === generation) {
      notice(transfer.wrote ? '音频已保存，后续处理已取消。' : '已取消保存 ' + track.title);
    }
    throw error;
  }).finally(() => {
    clearTimeout(transfer.uiTimer);
    const restoreFocus = transfer.returnFocus && epoch === generation
      && (document.activeElement === document.body || document.activeElement?.dataset?.saveKey === key);
    if (saveTransfers.get(key) === transfer) saveTransfers.delete(key);
    syncOfflineButtons(); renderSaveTransfers();
    if (restoreFocus) ($('save-operations').querySelector('.cancel-save:not(:disabled)') || $('offline-heading')).focus({ preventScroll: true });
    else if (!transfer.cancelled && epoch === generation) restoreTrackListFocus(transfer.rowFocus);
  });
}
function removeOffline(track) {
  if (track.access !== 'public' || !track.offlineAllowed) return Promise.reject(new Error('受限曲目没有可移除的离线副本'));
  const epoch = generation;
  const focused = document.activeElement;
  const container = focused?.closest?.('#offline-tracks, #results');
  const focus = container ? trackListFocus(container, container.id === 'results' ? $('catalogue-heading') : $('offline-heading')) : null;
  return storageOperations.run(keyFor(track), 'remove', async signal => {
    current(epoch, signal);
    await deleteCachedTrack(keyFor(track), { signal });
    announceOfflineChange(track.instanceId); current(epoch, signal);
    await refreshOffline(); current(epoch, signal); notice('已移除 ' + track.title + ' 的离线副本');
  }).finally(() => { if (epoch === generation) restoreTrackListFocus(focus); });
}
function cancelOfflineSave(key) {
  const transfer = saveTransfers.get(key);
  if (!transfer || transfer.cancelled || storageOperations.state(key)?.kind !== 'save') return;
  transfer.returnFocus = document.activeElement?.dataset?.saveKey === key && document.activeElement.classList.contains('cancel-save');
  transfer.cancelled = true;
  if (!storageOperations.cancel(key)) transfer.cancelled = false;
  syncOfflineButtons(); renderSaveTransfers();
}
function transferLabel(key, transfer) {
  if (transfer?.cancelled) return '正在取消…';
  const state = storageOperations.state(key);
  if (state?.phase === 'waiting') return '等待其他页面完成操作';
  const labels = { waiting: '等待保存', checking: '检查已有副本', preparing: '正在准备音频', verifying: '正在校验音频', writing: '正在保存到此浏览器', finishing: '正在完成保存' };
  return transfer?.phase === 'downloading' ? `正在下载 · ${Math.floor(100 * transfer.receivedBytes / transfer.totalBytes)}%` : labels[transfer?.phase] || '等待保存';
}
function renderSaveTransfers() {
  const container = $('save-operations'); if (!container) return;
  const items = [...saveTransfers].filter(([, transfer]) => transfer.epoch === generation);
  const keys = new Set(items.map(([key]) => key));
  const focused = document.activeElement;
  const lostFocus = focused?.closest?.('#save-operations') && !keys.has(focused.dataset.saveKey);
  for (const node of [...container.children]) if (!keys.has(node.dataset.saveKey)) node.remove();
  for (const [key, transfer] of items) {
    let node = [...container.children].find(node => node.dataset.saveKey === key);
    if (!node) {
      node = document.createElement('div'); node.className = 'save-operation'; node.dataset.saveKey = key;
      const title = document.createElement('strong'); title.className = 'save-title'; title.textContent = transfer.title;
      const status = document.createElement('p'); status.className = 'save-progress-status';
      const progress = document.createElement('progress'); progress.className = 'save-progress'; progress.setAttribute('aria-label', '保存 ' + transfer.title + ' 的下载进度');
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'button cancel-save'; cancel.dataset.saveKey = key;
      cancel.textContent = '取消保存'; cancel.setAttribute('aria-label', '取消保存 ' + transfer.title); cancel.onclick = () => cancelOfflineSave(key);
      node.append(title, status, progress, cancel); container.append(node);
    }
    const status = node.querySelector('.save-progress-status'), label = transferLabel(key, transfer);
    if (status.textContent !== label) status.textContent = label;
    const progress = node.querySelector('progress'); progress.max = transfer.totalBytes; progress.value = transfer.receivedBytes;
    progress.hidden = !['downloading', 'verifying', 'writing', 'finishing'].includes(transfer.phase);
    const cancel = node.querySelector('.cancel-save'); cancel.disabled = transfer.cancelled || storageOperations.state(key)?.kind !== 'save';
    cancel.textContent = transfer.cancelled ? '正在取消…' : '取消保存';
  }
  $('active-saves').hidden = items.length === 0;
  const summary = items.length ? `正在保存 ${items.length} 首曲目，可逐首取消。` : '';
  if ($('save-summary').textContent !== summary) $('save-summary').textContent = summary;
  if (lostFocus && (document.activeElement === focused || document.activeElement === document.body)) {
    (container.querySelector('.cancel-save:not(:disabled)') || $('offline-heading')).focus({ preventScroll: true });
  }
}
function syncOfflineButtons() {
  for (const button of document.querySelectorAll('button[data-offline-key]')) {
    const state = storageOperations.state(button.dataset.offlineKey), removing = button.dataset.offlineAction === 'remove';
    const transfer = saveTransfers.get(button.dataset.offlineKey);
    const progressLabel = transfer?.phase === 'downloading' ? `下载 ${Math.floor(100 * transfer.receivedBytes / transfer.totalBytes)}%` : '正在保存';
    const label = state ? (state.kind === 'remove' ? '正在移除' : transfer?.cancelled ? '正在取消' : state.phase === 'waiting' ? '等待保存' : progressLabel) : removing ? '移除副本' : '保存离线';
    const unavailable = offlineReadState === 'unavailable';
    const signature = label + ':' + Boolean(state) + ':' + unavailable;
    if (button.dataset.offlineState !== signature) {
      button.dataset.offlineState = signature;
      button.innerHTML = iconMarkup(removing ? 'check' : 'download'); button.append(document.createTextNode(label));
      button.disabled = Boolean(state) || unavailable; button.classList.toggle('is-loading', Boolean(state));
      if (unavailable) button.setAttribute('aria-describedby', 'offline-error'); else button.removeAttribute('aria-describedby');
      if (state) button.setAttribute('aria-busy', 'true'); else button.removeAttribute('aria-busy');
    }
  }
}
function trackListFocus(container, heading) {
  const focus = document.activeElement;
  if (!container.contains(focus)) return null;
  const focusedRow = focus.closest('.track');
  return { container, heading, focus, focusedKey: focusedRow?.dataset.trackKey, action: focus.dataset.listAction,
    oldIndex: focusedRow ? [...container.children].filter(node => trackRows.has(node)).indexOf(focusedRow) : 0 };
}
function restoreTrackListFocus(intent) {
  if (!intent) return;
  const { container, heading, focus, focusedKey, action, oldIndex } = intent;
  const nodes = [...container.children].filter(node => trackRows.has(node));
  const usable = control => control && !control.disabled
    && (!control.closest('details:not([open])') || control.tagName === 'SUMMARY') && control.getClientRects().length;
  const findAction = (node, requested) => [...(node?.querySelectorAll('[data-list-action]') || [])]
    .find(control => control.dataset.listAction === requested && usable(control));
  // A disabled pending action retains its keyboard place until it settles.
  // Redirect only when the control was removed/hidden or a moved row lost focus.
  if (focus.isConnected && document.activeElement === focus && focus.getClientRects().length
    && (!focus.closest('details:not([open])') || focus.tagName === 'SUMMARY')) {
    keepFocusedControlVisible(); return;
  }
  if (document.activeElement !== focus && document.activeElement !== document.body) return;
  const same = nodes.find(node => node.dataset.trackKey === focusedKey);
  const nearest = [...nodes].sort((a, b) => Math.abs(nodes.indexOf(a) - oldIndex) - Math.abs(nodes.indexOf(b) - oldIndex));
  const replacement = findAction(same, action) || findAction(same, 'play')
    || nearest.map(node => findAction(node, action)).find(Boolean) || nearest.map(node => findAction(node, 'play')).find(Boolean) || heading;
  replacement?.focus({ preventScroll: true }); keepFocusedControlVisible();
}
function renderTrackRows(container, items, saved, heading) {
  const focus = trackListFocus(container, heading);
  const previousRows = [...container.children].filter(node => trackRows.has(node));
  const previous = new Map(previousRows.map(node => [node.dataset.trackKey, node]));
  const nodes = items.map(track => {
    const node = previous.get(libraryTrackKey(track));
    if (!node) return row(track, saved);
    updateTrackRow(node, track, saved); return node;
  });
  const retained = new Set(nodes);
  for (const node of [...container.children]) if (!retained.has(node)) node.remove();
  // Reuse unchanged rows and their native controls. Move only rows whose order changed.
  let cursor = container.firstElementChild;
  for (const node of nodes) {
    if (node !== cursor) container.insertBefore(node, cursor);
    cursor = node.nextElementSibling;
  }
  restoreTrackListFocus(focus);
}
function updateTrackRow(node, track, saved) {
  const view = trackRows.get(node);
  view.track = track; view.saved = saved;
  const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  text(view.title, track.title); text(view.detail, track.artist || '测试素材');
  text(view.album, [track.album, track.year, track.trackNumber ? '第 ' + track.trackNumber + ' 首' : ''].filter(Boolean).join(' · '));
  view.album.hidden = !view.album.textContent;
  text(view.format, String(track.format || '').toUpperCase());
  if (view.access !== track.access) {
    view.access = track.access; view.permission.innerHTML = iconMarkup(track.access === 'public' ? 'check' : 'lock');
    view.permission.append(document.createTextNode(track.access === 'public' ? '公开' : '仅授权账号'));
  }
  text(view.duration, formatDuration(track.duration));
  view.play.dataset.playKey = libraryTrackKey(track); view.play.dataset.playTitle = track.title;
  view.summary.setAttribute('aria-label', '安排播放 ' + track.title);
  for (const [button, label] of view.menuActions) button.setAttribute('aria-label', label + ' ' + track.title);
  const cover = JSON.stringify([libraryTrackKey(track), track.artwork, track.cover_url, track.access, track.album]);
  if (view.coverSignature !== cover) { view.coverSignature = cover; renderCover(view.cover, track); }
  const showSave = track.access === 'public' && (saved || !libraryOffline);
  if (showSave) {
    if (!view.save) {
      view.save = document.createElement('button'); view.save.dataset.listAction = 'offline';
      view.save.onclick = () => { void (view.saved ? removeOffline(view.track) : saveOffline(view.track)).catch(handleError); };
    }
    view.save.classList.toggle('save-offline', !saved); view.save.classList.toggle('delete-offline', saved); view.save.classList.add('button');
    view.save.setAttribute('aria-label', (saved ? '移除离线副本 ' : '保存离线 ') + track.title);
    view.save.dataset.offlineKey = keyFor(track); view.save.dataset.offlineAction = saved ? 'remove' : 'save';
    if (view.save.parentElement !== view.actions) view.actions.insertBefore(view.save, view.options);
  } else if (view.save?.isConnected) view.save.remove();
}
function row(track, saved = false) {
  const node = document.createElement('div'); node.className = 'track'; node.dataset.songId = track.songId;
  const info = document.createElement('div'); info.className = 'track-info';
  const cover = document.createElement('div'); cover.className = 'track-cover';
  const text = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('small'); text.className = 'track-copy';
  title.textContent = track.title;
  detail.textContent = track.artist || '测试素材';
  const album = document.createElement('small'); album.className = 'album-copy';
  album.textContent = [track.album, track.year, track.trackNumber ? '第 ' + track.trackNumber + ' 首' : ''].filter(Boolean).join(' · ');
  const meta = document.createElement('div'); meta.className = 'track-meta';
  const format = document.createElement('span'); format.className = 'format-badge'; format.textContent = String(track.format || '').toUpperCase();
  const permission = document.createElement('span'); permission.className = 'permission-badge';
  permission.innerHTML = iconMarkup(track.access === 'public' ? 'check' : 'lock');
  permission.append(document.createTextNode(track.access === 'public' ? '公开' : '仅授权账号'));
  meta.append(format, permission); text.append(title, detail, album, meta); album.hidden = !album.textContent; info.append(cover, text);
  const duration = document.createElement('span'); duration.className = 'track-time';
  const durationLabel = document.createElement('span'); durationLabel.className = 'sr-only'; durationLabel.textContent = '时长 ';
  const durationValue = document.createElement('span'); durationValue.textContent = formatDuration(track.duration);
  duration.append(durationLabel, durationValue);
  const actions = document.createElement('div'); actions.className = 'actions';
  const play = document.createElement('button'); play.innerHTML = iconMarkup('play');
  const playLabel = document.createElement('span'); playLabel.className = 'play-label'; playLabel.textContent = '播放'; play.append(playLabel); play.className = 'button primary play-track';
  play.dataset.listAction = 'play';
  play.setAttribute('aria-label', '播放 ' + track.title);
  play.onclick = () => {
    void playTrack(view.track).catch(handleError);
  }; actions.append(play);
  const options = document.createElement('details'); options.className = 'track-options';
  const summary = document.createElement('summary'); summary.innerHTML = iconMarkup('more');
  summary.dataset.listAction = 'menu';
  summary.setAttribute('aria-label', '安排播放 ' + track.title); summary.title = '安排播放';
  const menu = document.createElement('div'); menu.className = 'track-menu';
  const menuActions = [];
  for (const [label, className, action] of [['下一首播放', 'queue-next', () => nextTracks([view.track])], ['追加到队列', 'queue-append', () => appendTracks([view.track])]]) {
    const button = document.createElement('button'); button.className = 'button ' + className; button.textContent = label;
    button.dataset.listAction = className;
    button.setAttribute('aria-label', label + ' ' + track.title);
    button.onclick = () => { options.open = false; summary.focus({ preventScroll: true }); action(); }; menu.append(button); menuActions.push([button, label]);
  }
  options.ontoggle = () => { if (options.open) for (const other of document.querySelectorAll('.track-options[open]')) if (other !== options) other.open = false; };
  options.append(summary, menu); actions.append(options); node.dataset.trackKey = libraryTrackKey(track);
  const view = { track, saved, title, detail, album, cover, format, permission, duration: durationValue, play, actions, options, summary, menuActions };
  trackRows.set(node, view);
  node.append(info, duration, actions); updateTrackRow(node, track, saved); return node;
}
document.addEventListener('click', event => {
  for (const options of document.querySelectorAll('.track-options[open]')) if (!options.contains(event.target)) options.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const options = document.activeElement?.closest('.track-options[open]');
  if (options) { options.open = false; options.querySelector('summary').focus(); event.preventDefault(); }
});
function queueFocusIntent() {
  const focus = document.activeElement, container = $('playback-queue');
  if (!container?.contains(focus)) return null;
  const node = focus.closest('.queue-item');
  return { focus, key: focus.dataset.queueKey, action: focus.dataset.queueAction,
    index: node ? [...container.children].indexOf(node) : 0 };
}
function restoreQueueFocus(intent) {
  if (!intent) return;
  const { focus, key, action, index } = intent, container = $('playback-queue');
  if (document.activeElement !== focus && document.activeElement !== document.body) return;
  const nodes = [...container.children], same = nodes.find(node => node.dataset.trackKey === key);
  const usable = button => button && !button.disabled && button.getClientRects().length;
  const find = (node, requested) => node?.querySelector('[data-queue-action="' + requested + '"]');
  if (container.contains(focus) && usable(focus)) {
    // A retained control needs no focus or scroll work on playback ticks.
    // Restore it only when a DOM move actually displaced the native focus.
    if (document.activeElement !== focus) {
      focus.focus({ preventScroll: true }); keepFocusedControlVisible();
    }
    return;
  }
  // A pending play retains its place; runPlayback restores it after settling.
  // Do not redirect that action to a different song while it is disabled.
  if (same && action === 'play' && focus.disabled
    && (playIntents.state()?.trackKey === key || status.trackLoading && libraryTrackKey(media.track) === key)) return;
  const near = [...nodes.slice(index), ...nodes.slice(0, index).reverse()];
  const candidate = [find(same, action), find(same, 'play'),
    ...near.map(node => find(node, action)), ...near.map(node => find(node, 'play'))].find(usable) || $('queue-heading');
  candidate.focus({ preventScroll: true }); keepFocusedControlVisible();
}
function queueRow(track) {
  const key = libraryTrackKey(track), node = document.createElement('li'); node.className = 'queue-item'; node.dataset.trackKey = key;
  const number = document.createElement('span'); number.className = 'queue-number';
  const copy = document.createElement('div'); copy.className = 'queue-copy';
  const title = document.createElement('strong'), details = document.createElement('div'); details.className = 'queue-meta';
  const artist = document.createElement('span'), state = document.createElement('span'); state.className = 'queue-state';
  details.append(artist, state); copy.append(title, details);
  const actions = document.createElement('div'); actions.className = 'queue-actions';
  const play = document.createElement('button'); play.className = 'icon-button queue-play'; play.innerHTML = iconMarkup('play');
  play.dataset.queueKey = key; play.dataset.queueAction = 'play';
  play.dataset.playKey = key; play.dataset.playQueue = 'true';
  play.onclick = () => {
    const index = queue.queue.findIndex(item => libraryTrackKey(item) === key), selected = queue.queue[index];
    if (selected) void runPlayback(() => queueControl.at(index), selected).catch(handleError);
  };
  const remove = document.createElement('button'); remove.className = 'icon-button queue-remove'; remove.innerHTML = iconMarkup('close');
  remove.dataset.queueKey = key; remove.dataset.queueAction = 'remove';
  remove.onclick = () => {
    const selected = queue.queue.find(item => libraryTrackKey(item) === key);
    if (!remove.disabled && selected && queueControl.remove(queue.queue.findIndex(item => libraryTrackKey(item) === key))) {
      renderQueue(); notice('已从队列移除 ' + selected.title);
    }
  };
  actions.append(play, remove); node.append(number, copy, actions);
  queueRows.set(node, { number, title, artist, state, play, remove }); return node;
}
function renderQueue() {
  if (!$('playback-queue')) return;
  const activeIndex = status.playIndex, items = queue.queue;
  // Progress ticks do not change queue presentation. Include every rendered
  // metadata/state input so same-version metadata and ordered edits still apply.
  const state = JSON.stringify([items.map(track => [libraryTrackKey(track), track.title, track.artist]),
    activeIndex, status.state, status.trackLoading, playIntents.state()?.trackKey || '', changingIdentity,
    queueOperationCount > 0, tracks.length > 0, playbackFailure?.key || '']);
  if (state === renderedQueueState) return;
  const container = $('playback-queue'), focus = queueFocusIntent();
  const previous = new Map([...container.children].filter(node => queueRows.has(node)).map(node => [node.dataset.trackKey, node]));
  const nodes = items.map(track => previous.get(libraryTrackKey(track)) || queueRow(track));
  const retained = new Set(nodes);
  for (const node of [...container.children]) if (!retained.has(node)) node.remove();
  let cursor = container.firstElementChild;
  for (const node of nodes) { if (node !== cursor) container.insertBefore(node, cursor); cursor = node.nextElementSibling; }
  const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  for (const [index, node] of nodes.entries()) {
    const view = queueRows.get(node), track = items[index];
    text(view.number, String(index + 1)); text(view.title, track.title); text(view.artist, track.artist || '');
    setAttribute(view.play, 'data-play-title', track.title);
    setAttribute(view.remove, 'aria-label', '从队列移除 ' + track.title);
    const active = index === activeIndex;
    setClass(node, 'is-current', active);
    setAttribute(node, 'aria-current', active ? 'true' : null);
    const preparing = playIntents.state()?.trackKey === libraryTrackKey(items[index]) || active && status.trackLoading;
    text(view.state, preparing ? '正在准备' : active ? (status.isPlaying ? '正在播放' : playbackFailure?.key === libraryTrackKey(track) ? '播放未能开始' : status.state === 'stopped' ? '已结束' : '当前曲目') : index < activeIndex ? '已播放' : '待播放');
    setProperty(view.remove, 'disabled', active || changingIdentity || queueOperationCount > 0);
    setProperty(view.remove, 'title', active ? '当前曲目保留，选择其他曲目可切换播放' : '从队列移除');
    setAttribute(node, 'aria-busy', preparing ? 'true' : null);
  }
  const upcoming = items.length - Math.max(0, activeIndex + 1);
  text($('queue-count'), `${items.length} 首 · ${upcoming} 首待播`);
  setProperty($('queue-empty'), 'hidden', items.length > 0);
  setProperty($('append-results'), 'disabled', !tracks.length || changingIdentity);
  setProperty($('replace-queue'), 'disabled', !tracks.length || changingIdentity || queueOperationCount > 0);
  setProperty($('clear-upcoming'), 'disabled', upcoming <= 0 || changingIdentity || queueOperationCount > 0);
  syncPlaybackButtons();
  restoreQueueFocus(focus);
  renderedQueueState = state;
}
function syncPlaybackButtons() {
  const busyKey = catalogueRecovery?.key || playIntents.state()?.trackKey || (status.trackLoading ? libraryTrackKey(media.track) : '');
  for (const button of document.querySelectorAll('button[data-play-key]')) {
    const busy = Boolean(busyKey && button.dataset.playKey === busyKey);
    const refreshing = Boolean(busy && catalogueRecovery?.key === busyKey);
    setProperty(button, 'disabled', changingIdentity || busy); setClass(button, 'is-loading', busy);
    setAttribute(button, 'aria-busy', busy ? 'true' : null);
    const label = refreshing ? '正在刷新曲库 ' + button.dataset.playTitle : busy ? '正在准备 ' + button.dataset.playTitle
      : (button.dataset.playQueue ? '播放队列中的 ' : '播放 ') + button.dataset.playTitle;
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
    setProperty(button, 'title', refreshing ? '正在刷新曲库，可用播放器暂停取消' : busy ? '正在准备，可用播放器暂停取消' : button.dataset.playQueue ? '播放这首' : '播放');
    const text = button.querySelector('.play-label');
    const caption = refreshing ? '刷新中' : busy ? '准备中' : '播放';
    if (text && text.textContent !== caption) text.textContent = caption;
  }
}
function renderTracks() {
  renderTrackRows($('results'), tracks.slice(0, visibleCount), false, $('catalogue-heading'));
  syncOfflineButtons();
  syncPlaybackButtons();
  const source = browseSource();
  const activeFilters = Boolean($('query').value.trim() || formatFilter || albumFilter || savedOnly);
  if (!tracks.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    const title = document.createElement('strong'), detail = document.createElement('p');
    if (!libraryOffline && sessionState === 'unavailable') { title.textContent = '请先重新确认账号状态'; detail.textContent = '在账号区域重试后，会读取当前可访问的曲目；已保存的公开曲目仍可收听。'; }
    else if (catalogueError && !libraryOffline) { title.textContent = '暂时无法读取曲库'; detail.textContent = catalogueError; }
    else if (!catalogueReady && !libraryOffline) { title.textContent = '正在读取曲库…'; }
    else if (source.length && activeFilters) { title.textContent = '没有符合条件的曲目'; detail.textContent = '试试更短的关键词，或清除筛选查看当前可用曲目。'; }
    else if (libraryOffline && offlineReadState === 'unavailable') {
      title.textContent = '暂时无法读取离线曲目'; detail.textContent = '请在“离线保存”中重试读取，恢复联网后也可在线收听。';
    } else { title.textContent = libraryOffline ? '还没有离线保存的曲目' : '当前没有可播放的曲目'; detail.textContent = libraryOffline ? '联网后保存公开曲目，即可在此离线收听。' : '重新读取曲库，或检查当前账号的曲目权限。'; }
    empty.append(title, detail);
    if (source.length && activeFilters) {
      const reset = document.createElement('button'); reset.className = 'button'; reset.textContent = '清除搜索与筛选'; reset.onclick = resetBrowseFilters; empty.append(reset);
    } else if (!libraryOffline && (catalogueError || catalogueReady)) {
      const retry = document.createElement('button'); retry.className = 'button'; retry.textContent = '重新读取曲库'; retry.onclick = () => { void search().catch(handleError); }; empty.append(retry);
    }
    $('results').append(empty);
  }
  const displayed = Math.min(tracks.length, visibleCount);
  $('track-count').textContent = !catalogueReady && !libraryOffline && !catalogueError ? '正在连接…' : `${tracks.length} / ${source.length} 首`;
  $('browse-summary').textContent = !libraryOffline && sessionState === 'unavailable' ? '账号状态尚未确认，请先重试。' : catalogueError && !libraryOffline ? '读取失败，重新读取后可继续筛选。' : !catalogueReady && !libraryOffline ? '正在读取当前可访问的曲目。' : `${libraryOffline ? '离线' : '当前'}找到 ${tracks.length} 首，已显示 ${displayed} 首。`;
  $('browse-reset').disabled = !activeFilters;
  $('browse-more').hidden = tracks.length <= displayed;
  $('browse-more').textContent = `显示更多（还有 ${tracks.length - displayed} 首）`;
  $('catalogue-heading').textContent = libraryOffline ? '已保存的曲目' : '曲库';
  $('start-listening').disabled = !tracks.length || changingIdentity;
  renderCover($('feature-art'), tracks[0] || { songId: 'welcome' });
  renderQueue();
}
function renderIdentity() {
  $('identity').textContent = libraryOffline ? '当前离线' : sessionState === 'checking' ? '正在确认账号…'
    : sessionState === 'unavailable' ? '账号状态未确认' : user ? '已登录 · ' + user.username : '访客';
  $('identity-note').textContent = libraryOffline ? '可播放已保存的公开曲目。登录和受限曲目需要联网。'
    : sessionState === 'unavailable' ? '请重新确认账号状态，已保存的公开曲目仍可收听。'
    : sessionState === 'checking' ? '正在读取当前会话，请稍候。' : user ? '曲库只显示此账号可以访问的曲目。' : '公开曲目无需登录即可收听。';
  $('login-form').hidden = libraryOffline || Boolean(user) || !(sessionState === 'ready' || sessionState === 'checking' && sessionMethod === 'POST');
  const loginButton = $('login-form').querySelector('button');
  loginButton.disabled = changingIdentity; loginButton.textContent = changingIdentity && sessionMethod === 'POST' ? '正在登录…' : '登录';
  loginButton.setAttribute('aria-busy', String(changingIdentity && sessionMethod === 'POST'));
  $('logout').hidden = libraryOffline || sessionState !== 'ready' || !user;
  $('logout').disabled = changingIdentity;
  $('session-error').hidden = libraryOffline || !sessionError;
  $('session-error').textContent = sessionError;
  $('retry-session').hidden = libraryOffline || sessionState !== 'unavailable';
  $('retry-session').disabled = changingIdentity;
  $('account-section').dataset.offline = String(libraryOffline);
  $('account-section').setAttribute('aria-busy', String(changingIdentity));
  $('connection-state').textContent = libraryOffline ? '当前离线' : '本机曲库';
}
function browseSource() {
  return libraryOffline ? offline.map(item => item.track) : catalogue;
}
function applyBrowse(resetPage = false) {
  if (resetPage) visibleCount = BROWSE_PAGE_SIZE;
  const source = browseSource(), choices = albumChoices(source);
  if (albumFilter && !choices.some(choice => choice.value === albumFilter)) albumFilter = '';
  const signature = JSON.stringify(choices);
  if (signature !== albumSignature) {
    albumSignature = signature;
    const all = document.createElement('option'); all.value = ''; all.textContent = '全部专辑';
    $('filter-album').replaceChildren(all, ...choices.map(choice => { const option = document.createElement('option'); option.value = choice.value; option.textContent = `${choice.label}（${choice.count}）`; return option; }));
  }
  $('filter-album').value = albumFilter;
  $('filter-saved').disabled = libraryOffline || offlineReadState === 'unavailable';
  const savedKeys = new Set(offline.map(item => keyFor(item.track)));
  tracks = browseTracks(source, { query: $('query').value, format: formatFilter, album: albumFilter, savedOnly: savedOnly && !libraryOffline, sort: browseSort }, savedKeys, keyFor);
  renderTracks();
}
function resetBrowseFilters() {
  clearTimeout(searchInputTimer); $('query').value = '';
  formatFilter = ''; albumFilter = ''; savedOnly = false;
  $('filter-format').value = ''; $('filter-album').value = ''; $('filter-saved').checked = false;
  applyBrowse(true); $('query').focus();
}
function networkFailure(error) { return error?.kind === 'network'; }
async function enterOffline(stop = false) {
  if (stop) invalidate(!publicBlobIsAttached(), false);
  libraryOffline = true; user = null; changingIdentity = false;
  sessionRevision++; sessionController?.abort(); sessionState = 'unavailable'; sessionError = '';
  $('login-error').hidden = true;
  $('username').value = ''; $('password').value = '';
  renderIdentity();
  await refreshOffline();
  $('results').setAttribute('aria-busy', 'false');
  notice(offline.length ? '当前离线，已保存的公开曲目可以继续收听。' : '当前离线。联网保存公开曲目后，可在此收听。');
}
async function search() {
  clearTimeout(searchInputTimer);
  if (libraryOffline) { applyBrowse(true); return; }
  if (sessionState !== 'ready') return;
  catalogueController?.abort();
  const epoch = generation, searchId = ++searchGeneration, controller = begin();
  catalogueController = controller; catalogueError = '';
  $('results').setAttribute('aria-busy', 'true');
  try {
    // Read only the current authorization's catalogue; text/facets/sort are derived locally.
    const result = await request('/api/search', { signal: controller.signal });
    current(epoch, controller.signal); if (searchId !== searchGeneration) return;
    if (result.instanceId !== instanceId || !Array.isArray(result.tracks)) throw new Error('曲库数据已变化，请重新连接。');
    catalogue = result.tracks; catalogueReady = true; applyBrowse(true);
  } catch (error) {
    if (controller.signal.aborted || epoch !== generation || searchId !== searchGeneration) return;
    if (networkFailure(error) && !navigator.onLine) { await enterOffline(true); return; }
    catalogue = []; catalogueReady = false; catalogueError = '请重新读取曲库；当前播放队列保持不变。';
    tracks = []; applyBrowse(true);
    throw error;
  } finally { pending.delete(controller); if (catalogueController === controller) catalogueController = null; if (searchId === searchGeneration || libraryOffline) $('results').setAttribute('aria-busy', 'false'); }
}
function sessionValue(value) {
  const validText = text => typeof text === 'string' && text.length > 0 && text.length <= 128 && !/[\u0000-\u001f]/.test(text);
  if (!validText(value?.instanceId) || !(value.user === null || value.user && validText(value.user.id) && validText(value.user.username))) {
    throw new Error('账号状态响应无效，请重新确认。');
  }
  return value;
}
async function performSession(method = 'GET', data, { stop = false, keepPublicBlob = false } = {}) {
  const focus = document.activeElement;
  let ownsFocus = method !== 'GET' && Boolean(focus?.closest('#account-section'));
  const relinquishFocus = event => {
    if (!event.target.closest?.('#account-section')) ownsFocus = false;
  };
  if (ownsFocus) document.addEventListener('focusin', relinquishFocus);
  sessionController?.abort();
  if (stop) invalidate(!(keepPublicBlob && publicBlobIsAttached()), !keepPublicBlob);
  if (stop && keepPublicBlob && publicBlobIsAttached()) queueControl.restrictOffline(offline.map(item => item.track), true);
  const revision = ++sessionRevision, epoch = generation, controller = begin(); sessionController = controller;
  libraryOffline = !navigator.onLine;
  changingIdentity = true; sessionMethod = method; sessionState = 'checking'; sessionError = ''; user = null;
  $('login-error').hidden = true; $('login-error').textContent = ''; renderIdentity();
  let confirmed = false;
  try {
    const response = await request('/api/session', { method, data, signal: controller.signal }); current(epoch, controller.signal);
    if (revision !== sessionRevision) return;
    const value = method === 'DELETE' ? { instanceId, user: response.user } : sessionValue(response);
    if (method === 'DELETE' && value.user !== null) throw new Error('退出状态响应无效，请重新确认账号。');
    if (instanceId && value.instanceId !== instanceId) invalidate();
    instanceId = value.instanceId; try { localStorage.setItem('library-lab-instance', instanceId); } catch {}
    user = value.user; libraryOffline = false; sessionState = 'ready'; confirmed = true;
    if (method !== 'GET') channel.postMessage('changed');
    if (method === 'POST') notice('登录成功');
    if (method === 'DELETE') notice('已退出登录，播放已停止');
  } catch (error) {
    if (controller.signal.aborted || epoch !== generation || revision !== sessionRevision) return;
    if (method === 'POST' && error.kind === 'http' && error.status < 500) {
      sessionState = 'ready'; user = null;
      $('login-error').textContent = error.message; $('login-error').hidden = false;
      if (error.status === 401) { $('username').setAttribute('aria-invalid', 'true'); $('password').setAttribute('aria-invalid', 'true'); }
      handleError(error);
    } else if (networkFailure(error) && !navigator.onLine) {
      await enterOffline(true);
    } else {
      const keepCurrent = publicBlobIsAttached();
      invalidate(!keepCurrent, false); if (keepCurrent) queueControl.restrictOffline([], true);
      sessionState = 'unavailable'; user = null;
      sessionError = method === 'DELETE' ? '暂时无法确认是否已退出，请重新确认账号状态。'
        : method === 'POST' ? '暂时无法确认登录结果，请重新确认账号状态。' : '暂时无法确认账号状态，请重试。';
      // A mutation may have reached the server even when its acknowledgement
      // was lost. Sibling pages must verify their actual shared cookie again.
      if (method !== 'GET') channel.postMessage('changed');
      handleError(error);
    }
  } finally {
    document.removeEventListener('focusin', relinquishFocus);
    pending.delete(controller); if (sessionController === controller) sessionController = null;
    if (revision === sessionRevision) {
      changingIdentity = false; renderIdentity(); if (sessionState === 'unavailable') renderTracks();
      // The submitting control may have been disabled or hidden. Keep keyboard
      // users in the account flow without overriding a deliberate focus move.
      if (ownsFocus && (document.activeElement === focus || document.activeElement === document.body)) {
        const target = libraryOffline ? $('identity') : sessionState === 'unavailable' ? $('retry-session')
          : user ? $('identity') : method === 'POST' && !$('login-error').hidden ? $('password') : $('username');
        target.focus({ preventScroll: true }); keepFocusedControlVisible();
      }
    }
  }
  // Catalogue failures are independent of a successfully confirmed session.
  if ((confirmed || sessionState === 'ready') && revision === sessionRevision && !libraryOffline) {
    const results = await Promise.allSettled([refreshOffline(), search()]);
    if (revision === sessionRevision) for (const result of results) if (result.status === 'rejected') handleError(result.reason);
  } else if (revision === sessionRevision) {
    await refreshOffline();
  }
}
function syncIdentity(stop = false, keepPublicBlob = false) { return performSession('GET', undefined, { stop, keepPublicBlob }); }
$('login-form').onsubmit = event => {
  event.preventDefault(); if (changingIdentity || libraryOffline || sessionState !== 'ready') return;
  $('login-error').hidden = true; $('username').removeAttribute('aria-invalid'); $('password').removeAttribute('aria-invalid');
  const data = { username: $('username').value.trim(), password: $('password').value };
  $('password').value = '';
  void performSession('POST', data, { stop: true }).catch(handleError);
};
$('logout').onclick = () => {
  if (changingIdentity || libraryOffline) return;
  void performSession('DELETE', undefined, { stop: true }).catch(handleError);
};
$('retry-session').onclick = () => {
  const button = $('retry-session'), hadFocus = document.activeElement === button;
  void syncIdentity(true, true).catch(handleError).finally(() => {
    if (hadFocus && (document.activeElement === button || document.activeElement === document.body)) {
      (sessionState === 'unavailable' ? button : $('identity')).focus({ preventScroll: true });
    }
  });
};
channel.onmessage = () => { if (!libraryOffline) void syncIdentity(true).catch(handleError); };
storageChannel.onmessage = event => {
  if (event.data?.type === 'changed' && event.data.instanceId === instanceId) void refreshOffline().catch(handleError);
};
window.addEventListener('focus', () => { void refreshOffline().catch(handleError); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshOffline().catch(handleError);
});
$('search-form').onsubmit = event => { event.preventDefault(); void search().catch(handleError); };
$('browse-sort').value = browseSort;
$('browse-sort').onchange = () => { browseSort = safeBrowseSort($('browse-sort').value); try { localStorage.setItem('mhub-library-sort', browseSort); } catch {} applyBrowse(true); };
$('filter-format').onchange = () => { formatFilter = $('filter-format').value; applyBrowse(true); };
$('filter-album').onchange = () => { albumFilter = $('filter-album').value; applyBrowse(true); };
$('filter-saved').onchange = () => { savedOnly = $('filter-saved').checked; applyBrowse(true); };
$('browse-reset').onclick = resetBrowseFilters;
$('browse-more').onclick = () => {
  const firstNew = visibleCount;
  visibleCount += BROWSE_PAGE_SIZE;
  const added = tracks.slice(firstNew, visibleCount).map(track => row(track)); $('results').append(...added);
  syncOfflineButtons();
  const displayed = Math.min(tracks.length, visibleCount);
  $('browse-summary').textContent = `${libraryOffline ? '离线' : '当前'}找到 ${tracks.length} 首，已显示 ${displayed} 首。`;
  $('browse-more').hidden = displayed >= tracks.length; $('browse-more').textContent = `显示更多（还有 ${tracks.length - displayed} 首）`;
  if ($('browse-more').hidden) added[0]?.querySelector('button')?.focus();
};
function inputSearch() { clearTimeout(searchInputTimer); if (!searchComposing) searchInputTimer = setTimeout(() => applyBrowse(true), 120); }
$('query').addEventListener('input', inputSearch);
$('query').addEventListener('compositionstart', () => { searchComposing = true; clearTimeout(searchInputTimer); });
$('query').addEventListener('compositionend', () => { searchComposing = false; inputSearch(); });
$('transport').onclick = () => {
  if (catalogueRecovery) {
    cancelCatalogueRecovery(); notice('已取消刷新，播放保持停止。');
  } else if (status.trackLoading || playIntents.state()) {
    playIntents.cancel(); retryRevision++;
    cancelPlaybackRequests();
    player.pause(); playbackFailure = null; retryingPlaybackKey = ''; renderPlaybackFeedback(); notice('已暂停，准备操作已取消。');
  } else if (status.isPlaying) {
    player.pause(); playbackFailure = null; renderPlaybackFeedback(); notice('已暂停');
  } else if (playbackFailure) retryCurrentPlayback();
  else if (media.track) void runPlayback(() => player.play(), media.track).catch(handleError);
};
function replaceCurrentResults() {
  if (!tracks.length) return;
  const snapshot = [...tracks];
  void runPlayback(() => queueControl.replace(snapshot), snapshot[0], { intentKey: JSON.stringify(['replace', snapshot.map(libraryTrackKey)]) }).catch(handleError);
}
$('start-listening').onclick = replaceCurrentResults;
$('replace-queue').onclick = replaceCurrentResults;
$('append-results').onclick = () => appendTracks(tracks);
$('clear-upcoming').onclick = () => {
  const focused = document.activeElement === $('clear-upcoming'), count = queueControl.clearUpcoming();
  renderQueue(); notice(`已清除 ${count} 首待播曲目，当前曲目保留。`);
  if (focused && $('clear-upcoming').disabled && (document.activeElement === $('clear-upcoming') || document.activeElement === document.body)) {
    const current = [...$('playback-queue').querySelectorAll('.queue-play')].find(button => !button.disabled);
    (current || $('queue-heading')).focus({ preventScroll: true }); keepFocusedControlVisible();
  }
};
function moveTrack(direction) {
  const selected = queue.getTrack(status.playIndex + direction);
  if (selected && !changingIdentity) void runPlayback(() => queueControl.step(direction), selected).catch(handleError);
}
$('previous-track').onclick = () => moveTrack(-1);
$('next-track').onclick = () => moveTrack(1);
$('volume').oninput = () => { player.setVolume(Number($('volume').value)); };
let unmutedVolume = status.volume;
$('mute-toggle').onclick = () => {
  if (status.volume > 0) { unmutedVolume = status.volume; player.setVolume(0); }
  else player.setVolume(unmutedVolume || .35);
};
const formatTime = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
function readSeekState() {
  const value = { key: JSON.stringify([generation, libraryTrackKey(media.track), status.currentSource]),
    enabled: Boolean(media.track && status.currentSource && !status.trackLoading && !changingIdentity && !playIntents.state()),
    duration: Math.max(0, (status.duration || media.track?.duration || 0) / 1000), position: status.position / 1000 };
  if (!value.enabled) return value;
  // This page plays native MP3/FLAC. Sample its attached source, rather than
  // the shared interpolated clock, which may run ahead of actual media time.
  let source;
  try { source = new URL(status.currentSource, location.href).href; } catch { return value; }
  const native = [...document.querySelectorAll('audio[src]')].find(element => (element.currentSrc || element.src) === source);
  if (native && !native.seeking && Number.isFinite(native.currentTime)) value.position = native.currentTime;
  return value;
}
const seekInput = createSeekInput({
  readState: readSeekState,
  seek: position => player.seek(position), onChange: () => renderSeek(),
});
function renderSeek() {
  const view = seekInput.view(), slider = $('seek');
  setProperty(slider, 'max', String(view.max)); setProperty(slider, 'disabled', !view.enabled);
  if (Number(slider.value) !== view.value) slider.value = view.value;
  const time = formatTime(view.value);
  const duration = Math.max(0, (status.duration || media.track?.duration || 0) / 1000);
  const description = (view.preview ? '预览 ' : '') + time + '，总时长 ' + formatTime(duration)
    + (view.preview ? '，松开后跳转' : '');
  if (slider.getAttribute('aria-valuetext') !== description) slider.setAttribute('aria-valuetext', description);
  setText($('position'), (view.preview ? '预览 ' : '') + time);
  setText($('duration'), formatTime(duration));
}
$('seek').addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0 || !seekInput.begin(event.pointerId)) return;
  try { $('seek').setPointerCapture(event.pointerId); } catch { /* Native input still owns its default pointer gesture. */ }
});
$('seek').oninput = () => { seekInput.input(Number($('seek').value)); };
$('seek').onchange = () => { seekInput.change(Number($('seek').value)); };
$('seek').addEventListener('pointerup', event => { seekInput.end(event.pointerId); });
$('seek').addEventListener('pointercancel', event => {
  if (seekInput.view().pointerId === event.pointerId) seekInput.cancel({ release: true });
});
$('seek').addEventListener('lostpointercapture', event => {
  if (seekInput.view().pointerId === event.pointerId) seekInput.cancel();
});
// A cancelled capture may deliver pointerup elsewhere; still close that discarded gesture.
window.addEventListener('pointerup', event => { seekInput.end(event.pointerId); });
window.addEventListener('pointercancel', event => {
  if (seekInput.view().pointerId === event.pointerId) seekInput.cancel({ release: true });
});
$('seek').addEventListener('blur', () => { seekInput.cancel(); });
$('seek').addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'Escape' && seekInput.cancel()) { event.preventDefault(); renderSeek(); }
  else if (seekInput.keydown(event.key)) event.preventDefault();
});
$('seek').addEventListener('keyup', event => { if (seekInput.keyup(event.key)) event.preventDefault(); });
watch(() => [generation, libraryTrackKey(media.track), status.currentSource, status.trackLoading, status.duration, status.position, status.state], renderSeek, { flush: 'post' });
let displayedTrackId;
const pwa = setupLibraryPwa({ canUpdate: () => !status.isPlaying && status.state !== 'buffering'
  && !status.trackLoading && pending.size === 0 && storageOperations.size === 0 && !changingIdentity && queueOperationCount === 0 && playIntents.pendingCount === 0
  && !catalogueRecovery
  && !seekInput.view().editing && ![...document.querySelectorAll('audio')].some(element => element.seeking) });
window.addEventListener('offline', () => { void enterOffline(true).catch(handleError); });
window.addEventListener('online', () => {
  void syncIdentity(true, true).catch(async error => { if (networkFailure(error)) await enterOffline(); else handleError(error); });
});
setInterval(() => {
  sweepPlaybackResources();
  if (document.hidden) return;
  pwa.refresh();
  renderPlaybackFeedback();
  renderQueue();
  player.tickPlaybackTime();
  setText($('now-playing'), media.track?.title || '选择一首曲目');
  const index = status.playIndex;
  setProperty($('previous-track'), 'disabled', index <= 0 || changingIdentity);
  setProperty($('next-track'), 'disabled', index < 0 || index >= queue.queueLength - 1 || changingIdentity);
  setProperty($('start-listening'), 'disabled', !tracks.length || changingIdentity || queueOperationCount > 0);
  const artworkIdentity = libraryTrackKey(media.track) + ':' + (media.track?.artwork?.sha256 || '');
  if (displayedTrackId !== artworkIdentity) {
    displayedTrackId = artworkIdentity;
    renderCover($('player-art'), media.track || { songId: 'welcome' });
  }
  for (const track of document.querySelectorAll('.track')) setClass(track, 'is-current', Boolean(media.track) && track.dataset.trackKey === libraryTrackKey(media.track));
  iconButtonContent($('mute-toggle'), status.volume > 0 ? 'volume' : 'muted', status.volume > 0 ? '静音' : '恢复音量');
  if (document.activeElement !== $('volume') && Number($('volume').value) !== status.volume) $('volume').value = status.volume;
  setAttribute($('volume'), 'aria-valuetext', Math.round(status.volume * 100) + '%');
  renderSeek();
}, 150);
// Read-only diagnostics for repeatable browser evidence; no credentials here.
window.libraryLab = { snapshot: () => ({ user: user ? { id: user.id, username: user.username } : null, instanceId,
  offlineMode: libraryOffline,
  offlineStorage: offlineReadState,
  sessionState,
  offlineDownloads: [...saveTransfers].filter(([, transfer]) => transfer.epoch === generation).map(([key, transfer]) => ({ key, phase: transfer.phase,
    receivedBytes: transfer.receivedBytes, totalBytes: transfer.totalBytes, cancelled: transfer.cancelled })),
  playbackFeedback: playbackFailure ? { kind: playbackFailure.kind, recovery: playbackFailure.recovery, refreshed: Boolean(playbackFailure.refreshed),
    canRetry: !status.trackLoading && !changingIdentity && !retryingPlaybackKey && !catalogueRecovery } : null,
  playbackIntent: playIntents.state(), pendingPlaybackActions: playIntents.pendingCount,
  seekInput: seekInput.view(),
  browse: { sourceCount: browseSource().length, matches: tracks.length, displayed: Math.min(tracks.length, visibleCount), sort: browseSort, format: formatFilter, savedOnly, hasQuery: Boolean($('query').value.trim()) },
  queue: queue.queue.map(track => ({ songId: track.songId, version: track.version, access: track.access })), playIndex: status.playIndex,
  state: status.state, loading: status.trackLoading, position: status.position, track: media.track ? { songId: media.track.songId, access: media.track.access } : null,
  audio: [...document.querySelectorAll('audio')].map(a => ({ time: a.currentTime, duration: Number.isFinite(a.duration) ? a.duration : null, paused: a.paused, ended: a.ended, attached: a.hasAttribute('src'), source: a.currentSrc || a.src })),
  cache: offline.map(item => ({ key: item.key, songId: item.track.songId, access: item.track.access, bytes: item.blob.size })),
  resources: { audioUrls: audioUrls.size, mediaTasks: taskResources.size, playbackRequests: playbackControllers.size, offlineOperations: storageOperations.size },
  pending: pending.size + storageOperations.size }) };
window.addEventListener('pagehide', event => {
  cancelCatalogueRecovery();
  seekInput.cancel({ release: true });
  playIntents.cancel();
  storageOperations.cancelAll(); cancelPlaybackRequests();
  for (const controller of pending) controller.abort();
  if (event.persisted) return;
  player.stop(); audioUrls.clear(); artworkCache.invalidate();
  for (const id of [...taskResources.keys()]) releaseTask(id);
});
window.addEventListener('pageshow', event => {
  if (event.persisted && !libraryOffline) void syncIdentity(true, true).catch(handleError);
});
invalidate();
const starting = libraryOffline ? enterOffline() : syncIdentity();
void starting.catch(error => { handleError(error); }).finally(() => { $('results').setAttribute('aria-busy', 'false'); window.libraryLabReady = true; });
