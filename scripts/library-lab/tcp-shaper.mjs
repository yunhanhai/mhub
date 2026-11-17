/** A bounded byte relay. It never terminates TLS or interprets HTTP. */
import assert from 'node:assert/strict';
import net from 'node:net';

export async function createTcpShaper({ targetPort, downBytesPerSecond = 0, upBytesPerSecond = 0, oneWayDelayMs = 0 } = {}) {
  assert.ok([downBytesPerSecond, upBytesPerSecond, oneWayDelayMs].every(value => Number.isFinite(value) && value >= 0));
  const maximumQueueBytes = 64 * 1024, chunkBytes = 16 * 1024;
  const records = [], links = new Set(); let nextId = 0;
  const settings = { downBytesPerSecond, upBytesPerSecond, oneWayDelayMs, maximumQueueBytes, chunkBytes };
  const server = net.createServer({ allowHalfOpen: true, highWaterMark: maximumQueueBytes }, client => {
    assert.ok(targetPort, 'Set the owned loopback target before connecting');
    const upstream = net.createConnection({ host: '127.0.0.1', port: targetPort, allowHalfOpen: true, highWaterMark: maximumQueueBytes });
    client.setNoDelay(true); upstream.setNoDelay(true);
    const record = { id: ++nextId, startedAt: new Date().toISOString(), clientPort: client.remotePort, closed: false,
      down: { bytes: 0, peakQueueBytes: 0, peakReadableBytes: 0, peakWritableBytes: 0, discardedQueueBytes: 0 },
      up: { bytes: 0, peakQueueBytes: 0, peakReadableBytes: 0, peakWritableBytes: 0, discardedQueueBytes: 0 } };
    records.push(record);
    const directions = [];
    const terminate = reason => {
      if (record.closed) return;
      record.closed = true; record.closedAt = new Date().toISOString(); record.closeReason = reason;
      for (const direction of directions) direction.stop();
      client.destroy(); upstream.destroy(); links.delete(link);
    };
    function direction(source, destination, rate, key) {
      let queueBytes = 0, timer, nextWrite = 0, blocked = false, pumping = false, ended = false, paused = false;
      const queue = [], stats = record[key];
      function sample() {
        stats.peakQueueBytes = Math.max(stats.peakQueueBytes, queueBytes);
        stats.peakReadableBytes = Math.max(stats.peakReadableBytes, source.readableLength);
        stats.peakWritableBytes = Math.max(stats.peakWritableBytes, destination.writableLength);
      }
      function fill() {
        if (record.closed) return;
        sample();
        while (queueBytes < maximumQueueBytes && source.readableLength > 0) {
          const size = Math.min(chunkBytes, maximumQueueBytes - queueBytes, source.readableLength);
          const bytes = source.read(size); if (!bytes) break;
          queue.push({ bytes, readyAt: performance.now() + oneWayDelayMs }); queueBytes += bytes.length;
        }
        sample(); source.read(0); pump();
      }
      function pump() {
        if (record.closed || pumping || blocked || paused) return;
        clearTimeout(timer); timer = undefined;
        pumping = true;
        try {
          while (queue.length && !blocked && !paused) {
            const now = performance.now(), due = Math.max(queue[0].readyAt, nextWrite);
            if (due > now) { timer = setTimeout(pump, Math.max(1, due - now)); break; }
            const { bytes } = queue.shift(); queueBytes -= bytes.length;
            blocked = !destination.write(bytes);
            stats.bytes += bytes.length;
            if (!stats.firstWriteAt) stats.firstWriteAt = new Date().toISOString();
            stats.lastWriteAt = new Date().toISOString();
            nextWrite = rate ? Math.max(now, nextWrite) + bytes.length * 1000 / rate : now;
            sample();
            fill();
          }
          if (ended && !queue.length && !destination.writableEnded) destination.end();
        } finally { pumping = false; }
      }
      source.on('readable', fill);
      source.on('end', () => { ended = true; pump(); });
      destination.on('drain', () => { blocked = false; fill(); pump(); });
      return {
        pause(value) { paused = value; if (!paused) { fill(); pump(); } },
        stop() { clearTimeout(timer); stats.discardedQueueBytes += queueBytes; queue.length = 0; queueBytes = 0; },
        get queueBytes() { return queueBytes; },
      };
    }
    const link = { record, terminate, pauseDown(value) { directions[1].pause(value); } };
    links.add(link);
    directions.push(direction(client, upstream, upBytesPerSecond, 'up'));
    directions.push(direction(upstream, client, downBytesPerSecond, 'down'));
    client.on('end', () => terminate('client-eof'));
    client.on('error', error => terminate('client-' + error.code));
    upstream.on('error', error => terminate('upstream-' + error.code));
    client.on('close', () => terminate('client-close'));
    upstream.on('close', () => { if (!upstream.readableEnded) terminate('upstream-close'); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, settings, records,
    setTarget(port) { assert.ok(Number.isInteger(port) && port > 0); targetPort = port; },
    get activeLinks() { return links.size; },
    pauseDown(value) { for (const link of links) link.pauseDown(value); },
    async close() { for (const link of [...links]) link.terminate('owned-shutdown'); await new Promise(resolve => server.close(resolve)); },
  };
}
