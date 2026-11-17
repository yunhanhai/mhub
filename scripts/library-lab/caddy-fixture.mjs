/** Actual Caddy process, named TLS origin, isolated Rust service and byte relay. */
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackend, apiBase, clientHeader } from './backend.mjs';
import { createTcpShaper } from './tcp-shaper.mjs';
import { http1Client } from './proxy-client.mjs';
import { pause, digest } from './resource-client.mjs';

export const proxyHostname = 'music.example.test';
async function unusedPort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
export async function createCaddyFixture(config, tracks, output, options = {}) {
  assert.ok(process.env.CADDY_EXECUTABLE && process.env.OPENSSL_EXECUTABLE && process.env.LIBRARY_BACKEND === 'rust');
  assert.equal(new URL(config.source.baseUrl).hostname, '127.0.0.1');
  await mkdir(output, { recursive: true });
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'mhub-caddy-fixture-'));
  let relay, app, child, caddyClosed, log = '', privateFilesRemoved = false, diagnosticProbeRequests = 0;
  const safeRemove = async () => {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('mhub-caddy-fixture-'));
    assert.equal((await lstat(directory)).isSymbolicLink(), false);
    await rm(resolved, { recursive: true }); privateFilesRemoved = true;
  };
  const run = args => {
    const value = spawnSync(process.env.OPENSSL_EXECUTABLE, args, { cwd: directory, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(value.status, 0, 'Ephemeral certificate command succeeds');
  };
  try {
    await writeFile(path.join(directory, 'request.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n');
    run(['req', '-config', 'request.cnf', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=MHub Proxy Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    run(['req', '-config', 'request.cnf', '-new', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=' + proxyHostname]);
    await writeFile(path.join(directory, 'leaf.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:' + proxyHostname + '\n');
    run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-sha256', '-extfile', 'leaf.ext']);
    const ca = await readFile(path.join(directory, 'ca.pem')), cert = await readFile(path.join(directory, 'leaf.pem'));
    const x509 = new X509Certificate(cert);
    const spki = createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    await writeFile(path.join(output, 'tls-public-ca.pem'), ca); await writeFile(path.join(output, 'tls-public-leaf.pem'), cert);
    const tlsPort = await unusedPort();
    relay = await createTcpShaper({ targetPort: tlsPort, ...options.shaping });
    const origin = 'https://' + proxyHostname + ':' + relay.port;
    const policyFile = path.join(output, 'policy.json'), cacheDir = path.join(output, 'cache');
    await writeFile(policyFile, JSON.stringify({ instanceId: config.source.instanceId, tracks }));
    app = await createBackend({ ...config, policyFile, cacheDir,
      ...(options.sessionTtlSeconds ? { sessionTtlSeconds: options.sessionTtlSeconds } : {}),
      ...(options.taskTtlSeconds ? { taskTtlSeconds: options.taskTtlSeconds } : {}) }, { origin, exclusive: true });
    app.origin = await app.start(); app.cacheDir = cacheDir;
    const idleSeconds = options.writeIdleSeconds ?? 4, totalSeconds = options.writeTotalSeconds || 0;
    const strictSniHost = options.strictSniHost !== false;
    const caddyfile = `{
  admin off
  auto_https off
  persist_config off
  skip_install_trust
  storage file_system {
    root ${JSON.stringify(path.join(directory, 'storage').replaceAll('\\', '/'))}
  }
  servers {
    protocols h1 h2
    ${strictSniHost ? 'strict_sni_host on' : '# Host/SNI matching omitted only for the explicit configuration control'}
    max_header_size 16KB
    timeouts {
      read_header 10s
      write ${totalSeconds}s
      write_idle ${idleSeconds}s
      idle 30s
    }
  }
}
https://${proxyHostname}:${tlsPort} {
  bind 127.0.0.1
  tls ${JSON.stringify(path.join(directory, 'leaf.pem').replaceAll('\\', '/'))} ${JSON.stringify(path.join(directory, 'leaf.key').replaceAll('\\', '/'))}
  reverse_proxy ${new URL(app.origin).host} {
    flush_interval 20ms
    transport http {
      versions 1.1
      dial_timeout 2s
      response_header_timeout 10s
    }
  }
}
`;
    const configuration = path.join(directory, 'Caddyfile'); await writeFile(configuration, caddyfile);
    const validated = spawnSync(process.env.CADDY_EXECUTABLE, ['validate', '--config', configuration, '--adapter', 'caddyfile'], { cwd: directory, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
    await writeFile(path.join(output, 'caddy-validate.log'), validated.stdout.toString() + validated.stderr.toString());
    assert.equal(validated.status, 0, 'The actual proxy accepts the configuration');
    child = spawn(process.env.CADDY_EXECUTABLE, ['run', '--config', configuration, '--adapter', 'caddyfile'], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    caddyClosed = new Promise(resolve => child.once('close', resolve));
    child.on('error', error => { log += '\n' + error.code; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes.toString()).slice(-32000); });
    const lab = { origin, ca, cert, relay, app, proxyPid: child.pid, tlsPort,
      certificate: { sha256: digest(x509.raw), caSHA256: digest(ca), spkiSHA256Base64: spki, validFrom: x509.validFrom, validTo: x509.validTo, subjectAltName: x509.subjectAltName },
      configuration: { proxy: 'Caddy', publicHost: proxyHostname, externalPort: relay.port, tlsPort,
        backendHTTPVersion: '1.1', enabledClientProtocols: ['h1', 'h2'], flushIntervalMs: 20,
        writeIdleSeconds: idleSeconds, writeTotalSeconds: totalSeconds, readHeaderSeconds: 10, idleConnectionSeconds: 30,
        adminDisabled: true, automaticHttpsDisabled: true, persistConfig: false, skipInstallTrust: true, strictSniHost,
        shaping: relay.settings },
      browserArgs: ['--no-proxy-server', '--ignore-certificate-errors-spki-list=' + spki, '--host-resolver-rules=MAP ' + proxyHostname + ' 127.0.0.1'],
      get privateFilesRemoved() { return privateFilesRemoved; },
      get diagnosticProbeRequests() { return diagnosticProbeRequests; },
      // Counters are flushed by existing library middleware, not by a body
      // destructor. An unshaped anonymous read refreshes the diagnostic file.
      // Do not use this to trigger an expiry that is supposed to be passive.
      async refreshMetrics() {
        diagnosticProbeRequests++;
        const status = await new Promise((resolve, reject) => {
          const request = http.get(app.origin + apiBase + '/session', { agent: false,
            headers: { host: new URL(origin).host, origin, [clientHeader]: '1', connection: 'close' } }, response => {
            response.resume(); response.once('end', () => resolve(response.statusCode)); response.once('error', reject);
          });
          request.setTimeout(1500, () => request.destroy(new Error('Owned diagnostic refresh deadline')));
          request.once('error', reject);
        });
        assert.equal(status, 200, 'Read-only owned diagnostic refresh');
        return { ...app.metrics };
      },
      async close() {
        await relay.close();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await caddyClosed; await app.close();
        await writeFile(path.join(output, 'caddy.log'), log);
        await safeRemove();
      },
    };
    const client = http1Client(lab); let healthy = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (child.exitCode !== null) break;
      try { const response = await client.request('/health', { timeout: 1000 }); if (response.status === 200) { healthy = true; break; } } catch {}
      await pause(100);
    }
    assert.ok(healthy, 'Owned Caddy must serve the real Rust health over trusted TLS');
    return lab;
  } catch (error) {
    await relay?.close();
    if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill();
    await caddyClosed; await app?.close();
    await writeFile(path.join(output, 'caddy.log'), log);
    await safeRemove();
    throw error;
  }
}
