"""Summarize raw Windows samples and closed-loop trial results without dependencies.

Usage: python summarize-resources.py CAPACITY_DIRECTORY
Keeps raw results unchanged. Re-run only in an unsealed/new report directory.
"""
from datetime import datetime
import json
import math
from pathlib import Path
import statistics
import sys

root = Path(sys.argv[1])
report = json.loads((root / 'capacity.json').read_text(encoding='utf-8-sig'))
assert 'checkCount' in report and not report.get('failure'), 'Wait for a complete benchmark.'
samples = []
for name in ['process-samples.jsonl', 'mixed-process-samples.jsonl']:
    for line in (root / name).read_text(encoding='utf-8-sig').splitlines():
        if line.strip():
            value = json.loads(line)
            value['_time'] = datetime.fromisoformat(value['recordedAt']).timestamp()
            value['_file'] = name
            samples.append(value)
samples.sort(key=lambda sample: sample['_time'])

def stats(values):
    if not values:
        return None
    values = sorted(values)
    return {'min': values[0], 'median': statistics.median(values),
            'p95': values[max(0, math.ceil(.95 * len(values)) - 1)], 'max': values[-1]}

def window(start, end):
    first, last = (datetime.fromisoformat(value).timestamp() for value in [start, end])
    selected = [sample for sample in samples if first <= sample['_time'] <= last]
    assert len(selected) >= 2, 'Insufficient native samples in a measurement window'
    result = {'samples': len(selected), 'durationSeconds': last - first, 'processes': {}}
    for role in ['rust', 'navidrome', 'generator']:
        values = [sample['processes'][role] for sample in selected if role in sample['processes'] and not sample['processes'][role].get('exited')]
        if not values:
            continue
        assert len({value['createdFiletime'] for value in values}) == 1, 'Process identity changed within a window'
        result['processes'][role] = {
            key: stats([value[key] for value in values if key in value])
            for key in ['cpuPercentMachine', 'cpuPercentOneCore', 'workingSetBytes', 'privateBytes', 'handles']
        }
        result['processes'][role]['tcpEstablished'] = stats([value.get('tcp', {}).get('established', 0) for value in values])
        result['processes'][role]['serverTcpEstablished'] = stats([value.get('serverTcp', {}).get('established', 0) for value in values])
        result['processes'][role]['pid'] = values[0]['pid']
    result['systemBusyPercent'] = stats([sample['system']['cpuPercentBusy'] for sample in selected if 'cpuPercentBusy' in sample.get('system', {})])
    result['systemAvailableBytes'] = stats([sample['system']['availablePhysicalBytes'] for sample in selected if 'system' in sample])
    result['samplerMilliseconds'] = stats([sample['samplingMilliseconds'] for sample in selected])
    return result

phases = []
for phase in report['phases']:
    value = {key: phase[key] for key in ['name', 'kind', 'passed', 'failed', 'startupP95Ms', 'controlP95Ms'] if key in phase}
    value['clients'] = phase.get('clients', phase.get('attempted'))
    value['native'] = window(phase['windowStart'], phase['windowEnd'])
    if phase['kind'] == 'mixed':
        value['attempts'] = phase['attempted']
        value['rejected429'] = phase['rejected429']
        value['errorRate'] = phase['failed'] / phase['attempted']
    phases.append(value)
idle = {
    'homogeneousBefore': window(report['idleBeforeStart'], report['idleBeforeEnd']),
    'homogeneousAfter': window(report['idleAfterStart'], report['idleAfterEnd']),
    'mixedBefore': window(report['mixed']['idleBeforeStart'], report['mixed']['idleBeforeEnd']),
    'mixedAfter': window(report['mixed']['idleAfterStart'], report['mixed']['idleAfterEnd']),
}
largest_warm = max((phase['attempted'] for phase in report['phases'] if phase['kind'] == 'warm' and phase['passed']), default=0)
largest_mixed = max((phase['clients'] for phase in report['phases'] if phase['kind'] == 'mixed' and phase['passed']), default=0)
result = {'profile': report['profile'], 'host': report['host'], 'cold': report['cold'], 'phases': phases, 'idle': idle,
          'largestObservedPassingWarmLevel': largest_warm, 'largestObservedPassingMixedLevel': largest_mixed,
          'limits': ['These are observed tested levels, not an estimated maximum or independent audit.',
                     'CPU samples cover approximately one-second intervals; boundary intervals can overlap phase startup or cleanup.',
                     'All private trials use an owned test account; they do not establish scale for distinct upstream user identities.',
                     'Client application-read pacing and loopback sockets do not reproduce a WAN or the production TLS edge.',
                     'Rapid mixed restarts exceed natural song-duration cadence; rejection counts remain visible.',
                     'A short soak and a finite memory trace cannot prove the absence of every leak.']}
(root / 'capacity-summary.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'phases': len(phases), 'largestObservedPassingWarmLevel': largest_warm, 'largestObservedPassingMixedLevel': largest_mixed,
                  'nativeSamples': len(samples), 'independentAudit': False}))
