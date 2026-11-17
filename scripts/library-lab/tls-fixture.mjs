/** Ephemeral loopback TLS laboratory, deliberately not a deployment proxy. */
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const hostnames = { library: 'music.example.test', sibling: 'sibling.example.test', attacker: 'attacker.other.test' };
const names = ['request.cnf', 'ca.key', 'ca.pem', 'ca.srl', 'leaf.key', 'leaf.csr', 'leaf.pem', 'leaf.ext'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cookiePresent = headers => /(?:^|;\s*)(?:__Host-)?mhub_library_session=/.test(headers.cookie || '');

export async function createTlsFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'mhub-tls-fixture-'));
  let server, plain, target, privateFilesRemoved = false;
  const records = [], sockets = new Set();
  const removePrivate = async () => {
    for (const name of names) await unlink(path.join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
    privateFilesRemoved = true;
  };
  const openssl = args => {
    const result = spawnSync(process.env.OPENSSL_EXECUTABLE || 'openssl', args, { cwd: directory, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw new Error('Ephemeral TLS certificate generation failed: ' + (result.error?.code || result.status) + ' ' + result.stderr?.toString().slice(-1500));
  };
  try {
    // Portable OpenSSL distributions may have a compiled-in config path that
    // does not exist here. Use only this explicit, ephemeral request config.
    await writeFile(path.join(directory, 'request.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n', { mode: 0o600 });
    openssl(['req', '-config', 'request.cnf', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=MHub Local Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    openssl(['req', '-config', 'request.cnf', '-new', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=music.example.test']);
    await writeFile(path.join(directory, 'leaf.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=' + Object.values(hostnames).map(name => 'DNS:' + name).join(',') + '\n', { mode: 0o600 });
    openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-sha256', '-extfile', 'leaf.ext']);
    const ca = await readFile(path.join(directory, 'ca.pem'));
    const cert = await readFile(path.join(directory, 'leaf.pem'));
    const key = await readFile(path.join(directory, 'leaf.key'));
    const x509 = new X509Certificate(cert);
    const spki = createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    server = https.createServer({ key, cert, minVersion: 'TLSv1.2' }, (request, response) => {
      const record = { transport: 'https', host: request.headers.host, method: request.method, path: request.url.split('?')[0], origin: request.headers.origin || null, fetchSite: request.headers['sec-fetch-site'] || null, sessionCookiePresent: cookiePresent(request.headers) };
      records.push(record);
      response.on('finish', () => { record.status = response.statusCode; });
      if (request.headers.host !== new URL(fixture.origin).host) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end('<!doctype html><title>Owned origin fixture</title><body>Owned origin fixture</body>');
        return;
      }
      if (!target) { response.writeHead(503).end(); return; }
      const { 'x-mhub-test-backend-host': backendHost, ...forwardHeaders } = request.headers;
      if (backendHost) record.simulatedBackendHost = backendHost;
      const upstream = http.request(new URL(request.url, target), { method: request.method, headers: { ...forwardHeaders, host: backendHost || request.headers.host, 'x-forwarded-proto': 'https' } }, source => {
        response.writeHead(source.statusCode, source.headers);
        source.pipe(response);
        source.on('error', () => response.destroy());
      });
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      response.on('close', () => upstream.destroy());
      request.pipe(upstream);
    });
    plain = http.createServer((request, response) => {
      const record = { transport: 'http', host: request.headers.host, method: request.method, path: request.url.split('?')[0], sessionCookiePresent: cookiePresent(request.headers), status: 200 };
      records.push(record);
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end('<!doctype html><title>HTTP transport fixture</title>HTTP transport fixture');
    });
    for (const listener of [server, plain]) {
      listener.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    }
    const tlsPort = server.address().port, httpPort = plain.address().port;
    const fixture = {
      origin: 'https://' + hostnames.library + ':' + tlsPort,
      siblingOrigin: 'https://' + hostnames.sibling + ':' + tlsPort,
      attackerOrigin: 'https://' + hostnames.attacker + ':' + tlsPort,
      httpOrigin: 'http://' + hostnames.library + ':' + httpPort,
      ca, cert, spki, records,
      certificate: { sha256: hash(x509.raw), caSHA256: hash(ca), spkiSHA256Base64: spki, validFrom: x509.validFrom, validTo: x509.validTo, subjectAltName: x509.subjectAltName },
      browserArgs: ['--no-proxy-server', '--ignore-certificate-errors-spki-list=' + spki, '--host-resolver-rules=' + Object.values(hostnames).map(name => 'MAP ' + name + ' 127.0.0.1').join(',')],
      setTarget(origin) { if (new URL(origin).hostname !== '127.0.0.1') throw new Error('Only an owned loopback Rust target is allowed'); target = origin; },
      get privateFilesRemoved() { return privateFilesRemoved; },
      async request(route, options = {}) {
        const url = new URL(route, fixture.origin);
        const body = options.data === undefined ? undefined : Buffer.from(JSON.stringify(options.data));
        return new Promise((resolve, reject) => {
          const req = https.request(url, {
            method: options.method || 'GET', ca: options.trust === false ? undefined : ca,
            rejectUnauthorized: true,
            lookup: (_host, settings, callback) => settings.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4),
            headers: Object.fromEntries(Object.entries({ 'accept-encoding': 'identity', ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}), ...options.headers }).filter(([, value]) => value !== undefined)),
          }, response => {
            const transport = { protocol: response.socket.getProtocol(), authorized: response.socket.authorized };
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: response.statusCode, headers: response.headers, bytes, ...transport }); });
          });
          req.setTimeout(20000, () => req.destroy(new Error('TLS fixture request timeout')));
          req.on('error', reject); req.end(body);
        });
      },
      async close() {
        for (const socket of sockets) socket.destroy();
        await Promise.all([server, plain].map(listener => new Promise(resolve => listener.close(resolve))));
        await removePrivate();
      },
    };
    return fixture;
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    for (const listener of [server, plain]) listener?.close();
    await removePrivate().catch(() => {});
    throw error;
  }
}
