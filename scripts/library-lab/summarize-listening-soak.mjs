// Recompute descriptive resource summaries from a preserved listening report.
// node scripts/library-lab/summarize-listening-soak.mjs REPORT_DIR
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = process.argv[2];
assert.ok(directory, 'Expected REPORT_DIR');
const source = JSON.parse(await readFile(path.join(directory, 'listening-soak.json'), 'utf8'));
assert.ok(Array.isArray(source.samples) && Array.isArray(source.cycles), 'Invalid listening report');
const stats = values => {
  const finite = values.filter(Number.isFinite);
  return finite.length ? { count: finite.length, min: Math.min(...finite), max: Math.max(...finite), first: finite[0], last: finite.at(-1) } : null;
};
const sum = (values, key) => values?.reduce((n, value) => n + value[key], 0) ?? null;
const samples = source.samples.map(sample => ({ phase: sample.phase, at: sample.at,
  elapsedSeconds: (Date.parse(sample.at) - Date.parse(source.startedAt)) / 1000,
  garbageCollected: sample.garbageCollected, heapBytes: sample.heapBytes, domNodes: sample.domNodes, listeners: sample.listeners,
  rendererWorkingSetBytes: sum(sample.rendererMemory, 'workingSetBytes'), rendererPrivateBytes: sum(sample.rendererMemory, 'privateBytes'),
  rendererProcessIds: sample.rendererCpu.map(p => p.id), resources: sample.snapshot.resources,
  cachedBytes: sample.snapshot.cache.reduce((n, item) => n + item.bytes, 0), fixtureTasks: sample.fixture.tasks }));
const cpuIntervals = [];
for (let index = 1; index < source.samples.length; index++) {
  const before = source.samples[index - 1], after = source.samples[index];
  const elapsedSeconds = (Date.parse(after.at) - Date.parse(before.at)) / 1000;
  const retained = after.rendererCpu.filter(p => before.rendererCpu.some(b => b.id === p.id));
  const cpuSeconds = retained.reduce((total, process) => total + Math.max(0, process.cpuSeconds
    - before.rendererCpu.find(p => p.id === process.id).cpuSeconds), 0);
  cpuIntervals.push({ from: before.phase, to: after.phase, elapsedSeconds, retainedProcessIds: retained.map(p => p.id),
    newProcessIds: after.rendererCpu.filter(p => !before.rendererCpu.some(b => b.id === p.id)).map(p => p.id),
    exitedProcessIds: before.rendererCpu.filter(p => !after.rendererCpu.some(a => a.id === p.id)).map(p => p.id),
    cpuSeconds, equivalentOneCorePercent: elapsedSeconds > 0 ? cpuSeconds / elapsedSeconds * 100 : null,
    scope: 'CPU deltas for renderer processes present at both endpoints only; exited/new process CPU and other browser processes excluded.' });
}
const phases = ['online', 'offline'].map(phase => {
  const cycles = source.cycles.filter(c => c.phase === phase), values = samples.filter(s => s.phase.startsWith(phase + '-'));
  return { phase, actualSeconds: source[phase + 'Seconds'], cycles: cycles.length,
    naturalEnds: cycles.reduce((n, cycle) => n + cycle.ended.length, 0),
    heapBytes: stats(values.map(s => s.heapBytes)), nodes: stats(values.map(s => s.domNodes)), listeners: stats(values.map(s => s.listeners)),
    workingSetBytes: stats(values.map(s => s.rendererWorkingSetBytes)), privateBytes: stats(values.map(s => s.rendererPrivateBytes)),
    resources: Object.fromEntries(['audioUrls', 'mediaTasks', 'playbackRequests', 'offlineOperations'].map(key => [key,
      stats(cycles.map(c => c.snapshot.resources[key]))])), fixtureTasks: stats(cycles.map(c => c.fixture.tasks)) };
});
const result = { recordedAt: new Date().toISOString(), passed: source.passed === true, finished: Boolean(source.finishedAt),
  requestedSeconds: source.requestedSeconds, actualSeconds: source.finishedAt ? (Date.parse(source.finishedAt) - Date.parse(source.startedAt)) / 1000 : null,
  browser: source.browser, release: source.release, phases, samples, cpuIntervals,
  collectedHeap: samples.filter(s => s.garbageCollected).map(s => ({ phase: s.phase, bytes: s.heapBytes })),
  naturalEnds: phases.reduce((n, phase) => n + phase.naturalEnds, 0), observedProgress: source.observedProgress,
  fixtureBeforeCleanup: source.fixtureBeforeCleanup, fixtureClosed: source.fixtureClosed,
  limitations: [source.scope,
    'Samples include instrumentation overhead; periodic heaps are not forced-GC samples. Compare the explicitly collected endpoints separately.',
    'Working sets/private memory are totals of this isolated browser renderer processes, including spare renderers, and exclude browser/GPU/audio processes.',
    'A bounded test with two originals does not establish multi-hour leak freedom, user capacity, mobile behavior or whole-device performance.',
    'The simulated API has no server-side expiry; requests lost while offline may remain in its task map until fixture teardown. This is not a Rust backend cleanup result.'] };
await writeFile(path.join(directory, 'listening-summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ passed: result.passed, finished: result.finished, actualSeconds: result.actualSeconds,
  naturalEnds: result.naturalEnds, samples: samples.length, output: path.join(directory, 'listening-summary.json') }));
