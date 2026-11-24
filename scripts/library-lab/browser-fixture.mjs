// Explicitly simulated API and generated media for isolated browser checks.
// This fixture never opens a music collection or uses real platform accounts.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function generatedAudio(format, duration, frequency) {
  return new Promise((resolve, reject) => execFile(process.env.FFMPEG_EXECUTABLE || 'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}`,
      '-ar', '44100', '-ac', '1', '-f', format, 'pipe:1'],
    { encoding: 'buffer', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}

export async function startBrowserFixture({ durationSeconds = 30, formats = ['mp3', 'mp3'], artwork = false } = {}) {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 3 || durationSeconds > 30
    || formats.length !== 2 || formats.some(f => !['mp3', 'flac'].includes(f))) throw new Error('Invalid generated fixture dimensions');
  const instanceId = 'accessibility-interface-fixture';
  const media = new Map();
  for (const format of new Set(formats)) media.set(format, await generatedAudio(format, durationSeconds, format === 'mp3' ? 220 : 330));
  const tracks = ['First Light', 'Slow River'].map((title, index) => {
    const songId = 'synthetic-' + index, format = formats[index], audio = media.get(format);
    const version = createHash('sha256').update(audio).digest('hex');
    const id = 'library-lab:' + [instanceId, songId, version, 'raw'].map(encodeURIComponent).join(':');
    return { id, source_id: id, instanceId, songId, version, platform: 'navidrome', quality: 'raw', title,
      artist: 'Generated interface fixture', album: 'Keyboard verification', duration: durationSeconds * 1000,
      format, content_type: format === 'mp3' ? 'audio/mpeg' : 'audio/flac', byte_size: audio.length,
      access: 'public', offlineAllowed: true, streaming_mode: '' };
  });
  const users = new Map(), tasks = new Map();
  const cover = artwork ? await new Promise((resolve, reject) => execFile(process.env.FFMPEG_EXECUTABLE || 'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=16x16', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
    { encoding: 'buffer', timeout: 30000, windowsHide: true, maxBuffer: 65536 }, (error, stdout) => error ? reject(error) : resolve(stdout))) : null;
  if (cover) for (const track of tracks) {
    track.artwork = { sha256: createHash('sha256').update(cover).digest('hex'), size: cover.length, width: 16, height: 16, contentType: 'image/jpeg' };
    track.cover_url = '/api/v1/library/artwork/' + track.songId + '?instanceId=' + instanceId + '&version=' + track.version;
  }
  const control = { sessionDelay: 0, failNextMutation: false, failNextTask: false, artworkMode: 'normal' };
  const counts = { taskCreates: 0, taskDeletes: 0, mediaResponses: 0, mediaActive: 0, peakTasks: 0, peakMedia: 0,
    requests: 0, artworkRequests: 0, artworkActive: 0, artworkClosed: 0 };
  const json = (response, status, value, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    response.end(JSON.stringify(value));
  };
  let origin;
  const server = createServer(async (request, response) => {
    counts.requests++;
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const session = /(?:^|;\s*)interface_fixture=([^;]+)/.exec(request.headers.cookie || '')?.[1];
      if (url.pathname === '/api/v1/library/session') {
        if (control.sessionDelay) await new Promise(resolve => setTimeout(resolve, control.sessionDelay));
        if (request.method === 'POST') {
          let body = ''; for await (const chunk of request) body += chunk;
          if (control.failNextMutation) { control.failNextMutation = false; return json(response, 503, { error: { code: 'unavailable', message: '测试账号确认暂时不可用。' } }); }
          const input = JSON.parse(body);
          if (input.username !== 'fixture' || input.password !== 'fixture') return json(response, 401, { error: { code: 'source_auth', message: '账号或密码不正确，请重新输入。' } });
          const token = randomUUID(); users.set(token, { id: 'fixture-user', username: 'fixture' });
          return json(response, 200, { instanceId, user: users.get(token) }, { 'Set-Cookie': 'interface_fixture=' + token + '; HttpOnly; SameSite=Strict; Path=/' });
        }
        if (request.method === 'DELETE') { users.delete(session); return json(response, 200, { user: null }); }
        return json(response, 200, { instanceId, user: users.get(session) || null });
      }
      if (url.pathname === '/api/v1/library/search') return json(response, 200, { instanceId, tracks });
      if (url.pathname.startsWith('/api/v1/library/artwork/') && cover) {
        const track = tracks.find(t => url.pathname.endsWith('/' + t.songId));
        if (!track || url.searchParams.get('instanceId') !== instanceId || url.searchParams.get('version') !== track.version) return json(response, 404, {});
        counts.artworkRequests++; counts.artworkActive++;
        response.once('close', () => { counts.artworkActive--; counts.artworkClosed++; });
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': cover.length, 'Cache-Control': 'no-store' });
        if (control.artworkMode === 'stall') { response.flushHeaders(); return; }
        return response.end(cover);
      }
      if (url.pathname === '/api/v1/library/tasks' && request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += chunk;
        const input = JSON.parse(body), track = tracks.find(t => t.songId === input.songId);
        if (!track) return json(response, 404, { error: { code: 'track_missing', message: '没有这首测试曲目' } });
        if (control.failNextTask) { control.failNextTask = false; return json(response, 503, { error: { code: 'source_unavailable', message: '测试音频暂时不可用，请重试播放。' } }); }
        const id = randomUUID().replaceAll('-', ''); tasks.set(id, track); counts.taskCreates++;
        counts.peakTasks = Math.max(counts.peakTasks, tasks.size);
        return json(response, 200, { id, state: 'ready', track, mediaUrl: origin + '/api/v1/library/tasks/' + id + '/audio' });
      }
      const taskMatch = /^\/api\/v1\/library\/tasks\/([^/]+)(\/audio)?$/.exec(url.pathname);
      if (taskMatch) {
        const [, id, isMedia] = taskMatch;
        if (request.method === 'DELETE') { if (tasks.delete(id)) counts.taskDeletes++; return json(response, 200, {}); }
        const track = tasks.get(id);
        if (!track) return json(response, 404, { error: { code: 'task_missing', message: '测试任务已结束' } });
        if (!isMedia) return json(response, 200, { id, state: 'ready', track, mediaUrl: origin + url.pathname + '/audio' });
        const audio = media.get(track.format), range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
        const start = range ? Number(range[1]) : 0, end = range && range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
        if (start >= audio.length) { response.writeHead(416, { 'Content-Range': 'bytes */' + audio.length }); return response.end(); }
        counts.mediaResponses++; counts.mediaActive++; counts.peakMedia = Math.max(counts.peakMedia, counts.mediaActive);
        response.once('close', () => counts.mediaActive--);
        response.writeHead(range ? 206 : 200, { 'Content-Type': track.content_type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${audio.length}` } : {}) });
        return response.end(request.method === 'HEAD' ? undefined : audio.subarray(start, end + 1));
      }
      if (!url.pathname.startsWith('/library/')) { response.writeHead(404); return response.end(); }
      const name = url.pathname.slice('/library/'.length) || 'index.html';
      if (!/^[\w.-]+$/.test(name)) { response.writeHead(404); return response.end(); }
      const bytes = await readFile(path.join(root, 'web/library', name));
      const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'application/javascript' : name.endsWith('.png') ? 'image/png' : 'application/manifest+json';
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' }); response.end(bytes);
    } catch (error) {
      if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, control, tracks,
    metrics: () => ({ ...counts, tasks: tasks.size, users: users.size }),
    async close() {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      tasks.clear(); users.clear(); media.clear();
    },
  };
}
