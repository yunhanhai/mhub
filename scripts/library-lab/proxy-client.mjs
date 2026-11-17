/** Real TLS HTTP/1.1 and HTTP/2 clients with explicit CA trust and byte accounting. */
import https from 'node:https';
import http2 from 'node:http2';
import { createHash } from 'node:crypto';
import { clientHeader } from './backend.mjs';

export const lookup = (_host, settings, callback) => settings.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
const cleanHeaders = headers => Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));

function observe(stream, { started, metadata, close, pauseFirst = false, collect = false, timeout = 60000, isH2 = false }) {
  let total = 0, firstByteMs, ended = false, settled = false, finish, begin, locallyCancelled = false;
  const digest = createHash('sha256'), chunks = [];
  const done = new Promise(resolve => { finish = resolve; }), opened = new Promise(resolve => { begin = resolve; });
  const timer = setTimeout(() => { close(); result({ code: 'CLIENT_DEADLINE' }); }, timeout);
  function result(error) {
    if (settled) return;
    settled = true; clearTimeout(timer);
    const body = collect ? Buffer.concat(chunks) : undefined;
    const length = Number(metadata.headers?.['content-length']);
    const value = { ...metadata, bytes: total, firstByteMs, milliseconds: performance.now() - started,
      sha256: digest.digest('hex'), complete: !error && ended && (isH2 || stream.complete) && (!Number.isFinite(length) || length === total),
      locallyCancelled, ...(error ? { error: error.code || error.message } : {}), ...(body ? { body } : {}) };
    finish(value); begin();
  }
  stream.on('data', chunk => {
    if (settled) return;
    if (firstByteMs === undefined) { firstByteMs = performance.now() - started; if (pauseFirst) stream.pause(); }
    total += chunk.length; digest.update(chunk); if (collect) chunks.push(chunk); begin();
  });
  stream.on('end', () => { ended = true; result(); });
  stream.on('aborted', () => result({ code: 'RESPONSE_ABORTED' }));
  stream.on('error', result);
  stream.on('close', () => { if (!ended) result({ code: isH2 ? 'H2_CLOSE_' + stream.rstCode : 'EARLY_CLOSE' }); });
  return { done, opened, get bytes() { return total; }, get firstByteMs() { return firstByteMs; }, get settled() { return settled; },
    get metadata() { return metadata; }, pause() { stream.pause(); }, resume() { stream.resume(); },
    close() { locallyCancelled = true; close(); }, };
}

function headers(lab, client, options, body) {
  return cleanHeaders({ origin: lab.origin, [clientHeader]: '1', 'accept-encoding': 'identity',
    ...(client.cookie ? { cookie: client.cookie } : {}),
    ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}), ...options.headers });
}
async function collect(reader) {
  const result = await reader.done;
  return { ...result, value: /json/.test(result.headers?.['content-type'] || '') && result.body?.length ? JSON.parse(result.body) : null };
}

export function http1Client(lab) {
  const client = { cookie: '', protocol: 'http/1.1' };
  client.media = async (route, options = {}) => {
    const started = performance.now(), body = options.data === undefined ? undefined : Buffer.from(JSON.stringify(options.data));
    const url = new URL(route, lab.origin);
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method: options.method || 'GET', agent: false, ca: options.trust === false ? undefined : lab.ca,
        rejectUnauthorized: true, lookup, ALPNProtocols: ['http/1.1'], headers: { ...headers(lab, client, options, body), connection: 'close' } }, response => {
        const metadata = { status: response.statusCode, headers: response.headers, alpn: response.socket.alpnProtocol,
          tls: response.socket.getProtocol(), authorized: response.socket.authorized };
        const reader = observe(response, { started, metadata, close: () => { response.destroy(); req.destroy(); }, ...options });
        reader.opened.then(() => resolve(reader));
      });
      req.setTimeout(options.timeout || 60000, () => req.destroy(Object.assign(new Error('HTTPS client deadline'), { code: 'CLIENT_DEADLINE' })));
      req.once('error', reject); req.end(body);
    });
  };
  client.request = async (route, options = {}) => collect(await client.media(route, { ...options, collect: true }));
  client.close = async () => {};
  return client;
}

export async function http2Client(lab) {
  const connectionStarted = performance.now();
  const errors = [], goaways = [];
  const session = http2.connect(lab.origin, { ca: lab.ca, rejectUnauthorized: true, lookup,
    settings: { initialWindowSize: 65535, enablePush: false } });
  const closed = new Promise(resolve => session.once('close', resolve));
  session.on('error', error => errors.push(error.code || error.name));
  session.on('goaway', code => goaways.push(code));
  await new Promise((resolve, reject) => { session.once('connect', resolve); session.once('error', reject); });
  const transport = { alpn: session.socket.alpnProtocol, tls: session.socket.getProtocol(), authorized: session.socket.authorized,
    connectionMilliseconds: performance.now() - connectionStarted };
  const client = { cookie: '', protocol: 'h2', transport, errors, goaways };
  client.media = async (route, options = {}) => {
    const started = performance.now(), body = options.data === undefined ? undefined : Buffer.from(JSON.stringify(options.data));
    const metadata = { ...transport };
    const req = session.request({ ':method': options.method || 'GET', ':path': route,
      ':scheme': 'https', ':authority': new URL(lab.origin).host, ...headers(lab, client, options, body) });
    req.on('response', response => { metadata.status = response[':status']; metadata.headers = response; });
    const reader = observe(req, { started, metadata, close: () => req.close(http2.constants.NGHTTP2_CANCEL), isH2: true, ...options });
    req.end(body); await reader.opened; return reader;
  };
  client.request = async (route, options = {}) => collect(await client.media(route, { ...options, collect: true }));
  client.close = async () => { session.destroy(); await closed; };
  return client;
}
