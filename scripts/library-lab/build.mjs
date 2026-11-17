// Build the shared player page for the Rust server's existing web directory.
// No configuration, upstream credentials or media are embedded in this bundle.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { html } from './shell.mjs';
import { iconPng } from './pwa-assets.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..'), frontend = path.join(root, 'frontend');
const require = createRequire(path.join(frontend, 'package.json'));
const result = await require('esbuild').build({ entryPoints: [path.join(directory, 'client.mjs')], nodePaths: [path.join(frontend, 'node_modules')], bundle: true, write: false, format: 'iife', minify: true });
const bytes = result.outputFiles[0].contents;
const hash = content => createHash('sha256').update(content).digest('hex');
const name = 'player-' + hash(bytes).slice(0,12) + '.js';
const icons = [192, 512].map(size => {
  const bytes = iconPng(size);
  return { name: 'icon-' + size + '-' + hash(bytes).slice(0,12) + '.png', bytes, size };
});
const manifestBytes = Buffer.from(JSON.stringify({
  id: '/library/', name: 'MHub 开放曲库', short_name: 'MHub', lang: 'zh-CN',
  description: '播放自己的曲库，保存公开曲目后可离线收听。', start_url: '/library/', scope: '/library/',
  display: 'standalone', background_color: '#101914', theme_color: '#101914', categories: ['music', 'entertainment'],
  icons: icons.map(icon => ({ src: '/library/' + icon.name, sizes: icon.size + 'x' + icon.size, type: 'image/png', purpose: 'any maskable' })),
}, null, 2));
const manifestName = 'manifest-' + hash(manifestBytes).slice(0,12) + '.webmanifest';
const workerTemplate = await readFile(path.join(directory, 'service-worker.mjs'), 'utf8');
const release = hash(Buffer.concat([bytes, Buffer.from(html), manifestBytes, Buffer.from(workerTemplate),
  Buffer.from(process.env.MHUB_LIBRARY_RELEASE_REVISION || '')])).slice(0,20);
const page = html.replace('<head>', '<head><meta name="mhub-library-api" content="/api/v1/library"><meta name="mhub-library-release" content="' + release + '">' +
  '<link rel="manifest" href="/library/' + manifestName + '"><link rel="apple-touch-icon" href="/library/' + icons[0].name + '">')
  .replace('src="/app.js"', 'src="/library/' + name + '"');
const target = process.env.MHUB_LIBRARY_BUILD_DIR ? path.resolve(process.env.MHUB_LIBRARY_BUILD_DIR) : path.join(root, 'web', 'library');
await mkdir(target, { recursive: true });
const assets = [[name, bytes, 'javascript'], ['index.html', Buffer.from(page), 'text/html'],
  [manifestName, manifestBytes, 'json'], ...icons.map(icon => [icon.name, icon.bytes, 'image/png'])];
const files = assets.map(([file, content, type]) => ({ url: file === 'index.html' ? '/library/' : '/library/' + file,
  bytes: content.length, sha256: hash(content), type }));
const worker = Buffer.from('const LIBRARY_BUILD = ' + JSON.stringify({ release, files }) + ';\n' + workerTemplate);
for (const [file, content] of [...assets, ['sw.js', worker]]) {
  await writeFile(path.join(target, file), content);
  if (!file.endsWith('.png')) {
    await writeFile(path.join(target, file + '.gz'), gzipSync(content, { level: 9 }));
    await writeFile(path.join(target, file + '.br'), brotliCompressSync(content));
  }
}
console.log('Rust library page built: ' + name + ', offline release ' + release);
