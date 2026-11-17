"""Recompute the cold-user denominators and timing/resource summaries from raw files.

Usage: python summarize-cold-users.py REPORT_DIR
The inputs are preserved. This checks consistency, not an independent audit.
"""
from datetime import datetime
from hashlib import file_digest
import json
import math
from pathlib import Path
import sys

root = Path(sys.argv[1])


def read(file):
    return json.loads(file.read_text(encoding='utf-8-sig'))


def digest(file):
    with file.open('rb') as stream:
        return file_digest(stream, 'sha256').hexdigest()


def instant(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def percentile(values, proportion=.95):
    values = sorted(value for value in values if isinstance(value, (int, float)) and math.isfinite(value))
    return values[max(0, math.ceil(len(values) * proportion) - 1)] if values else None


def between(sample, start, end):
    return start and end and instant(start) <= instant(sample['recordedAt']) <= instant(end)


def resources(samples):
    result = {'samples': len(samples), 'processes': {}}
    for role in ['rust', 'generator', 'navidrome']:
        values = [sample['processes'][role] for sample in samples if role in sample['processes'] and not sample['processes'][role].get('exited')]
        if not values:
            continue
        result['processes'][role] = {
            'samples': len(values), 'pids': sorted({value['pid'] for value in values}),
            'creationTimes': sorted({value['createdFiletime'] for value in values}),
            'workingSetPeakBytes': max(value['workingSetBytes'] for value in values),
            'privatePeakBytes': max(value['privateBytes'] for value in values),
            'handlesPeak': max(value['handles'] for value in values),
            'cpuPercentMachinePeak': max((value.get('cpuPercentMachine', 0) for value in values), default=0),
            'cpuPercentMachineP95': percentile([value.get('cpuPercentMachine') for value in values]),
            'serverEstablishedPeak': max(value.get('serverTcp', {}).get('established', 0) for value in values),
            'last': values[-1],
        }
    if samples:
        result['systemCpuPercentPeak'] = max(sample.get('system', {}).get('cpuPercentBusy', 0) for sample in samples)
    return result


raw_file = root / 'cold-users.json'
raw = read(raw_file)
originals = {value['label']: value for value in raw['originals']}
inputs = [{'file': raw_file.name, 'sha256': digest(raw_file)}]
phases = []
transient = ['activeFileLeases', 'activeMediaResponses', 'activeTasks', 'activeJobs',
             'reservedBytes', 'queuedPreparations', 'runningPreparations']
all_active_samples = []
for phase in raw['phases']:
    outcomes = phase['outcomes']
    assert phase['attempted'] == phase['startedAttempts']
    assert phase['outcomesRecorded'] == len(outcomes)
    assert phase['unrecordedAttempts'] == phase['attempted'] - len(outcomes)
    assert len({value['index'] for value in outcomes}) == len(outcomes)
    assert len({value['label'] for value in outcomes}) == len(outcomes), 'Every attempt must address a distinct file'
    whole, failed = [], []
    for value in outcomes:
        original = originals[value['label']]
        assert value['expectedBytes'] == original['bytes'] and value['expectedSHA256'] == original['sha256']
        correct = (value.get('stage') == 'body' and value.get('status') == 200 and value.get('complete')
                   and value.get('bytes') == original['bytes'] and value.get('sha256') == original['sha256'])
        assert bool(value['correct']) == bool(correct)
        (whole if correct else failed).append(value)
        if 'startupMs' in value:
            assert math.isclose(value['startupMs'], value['firstByteFromBurstMs'] - value['beginMs'], abs_tol=1e-8)
            if 'mediaFirstByteMs' in value:
                assert math.isclose(value['firstByteFromBurstMs'], value['mediaRequestStartMs'] + value['mediaFirstByteMs'], abs_tol=1e-8)
        if correct:
            assert value['contentLength'] == original['bytes'] and not value['locallyAborted']
    assert phase['failed'] == len(failed)
    controls = phase.get('controls', [])
    startup = percentile([value.get('startupMs') for value in outcomes])
    control_p95 = percentile([value['milliseconds'] for value in controls if value['correct']])
    control_errors = sum(not value['correct'] for value in controls)
    if not phase.get('failure'):
        assert phase['startupP95Ms'] == startup and phase['controlP95Ms'] == control_p95
        assert phase['controlErrors'] == control_errors and phase['completedCorrectOriginals'] == len(whole)
    users = []
    for role in ['u' + str(index) for index in range(1, 9)]:
        values = [value for value in outcomes if value['role'] == role]
        users.append({'role': role, 'attempted': len(values), 'failed': sum(not value['correct'] for value in values),
                      'startupP95Ms': percentile([value.get('startupMs') for value in values])})
    if phase.get('users'):
        assert sorted(phase['users'], key=lambda value: value['role']) == users
    latency_passed = (phase['attempted'] == phase['files'] and phase['unrecordedAttempts'] == 0
                      and not failed and all(value['attempted'] > 0 and not value['failed'] for value in users)
                      and all(isinstance(value.get('startupMs'), (int, float)) for value in outcomes)
                      and startup is not None and startup <= 2000 and controls and not control_errors
                      and control_p95 is not None and control_p95 <= 500)
    expected_passed = bool(latency_passed and not phase.get('failure') and not phase.get('cleanupErrors'))
    assert phase['passed'] == expected_passed
    native_file = root / phase['name'] / 'process-samples.jsonl'
    library_file = root / phase['name'] / 'library-samples.json'
    native = [json.loads(line) for line in native_file.read_text(encoding='utf-8-sig').splitlines() if line.strip()] if native_file.exists() else []
    library = read(library_file) if library_file.exists() else []
    for file in [native_file, library_file]:
        if file.exists():
            inputs.append({'file': file.relative_to(root).as_posix(), 'sha256': digest(file)})
    assert all(sample['counterClock'] == 'perf_counter' for sample in native)
    assert all(left['monotonicSeconds'] < right['monotonicSeconds'] for left, right in zip(native, native[1:]))
    active = [sample for sample in native if between(sample, phase.get('burstStart'), phase.get('verifiedAt'))]
    all_active_samples += active
    resource_values = {'active': resources(active)}
    for name in ['idleBefore', 'idleAfter']:
        resource_values[name] = resources([sample for sample in native if between(sample, phase.get(name + 'Start'), phase.get(name + 'End'))])
    after = phase.get('after', {})
    released = all(after.get(key) == 0 for key in transient)
    peaks = {key: max((sample.get(key, 0) for sample in library), default=0) for key in transient}
    phases.append({
        'name': phase['name'], 'files': phase['files'], 'realUsers': phase['realUsers'], 'repetition': phase['repetition'],
        'passed': phase['passed'], 'plannedAttempts': phase['plannedAttempts'], 'attempted': phase['attempted'],
        'outcomesRecorded': len(outcomes), 'unrecordedAttempts': phase['unrecordedAttempts'],
        'wholeCorrectResponses': len(whole), 'wholeCorrectBytes': sum(value['bytes'] for value in whole),
        'failed': len(failed), 'retainedFailures': failed, 'failure': phase.get('failure'),
        'startupP95Ms': startup, 'startupMaxMs': max((value.get('startupMs', 0) for value in outcomes), default=None),
        'controlP95Ms': control_p95, 'controlErrors': control_errors, 'controlAttempts': len(controls),
        'users': users, 'initialCache': phase.get('initialCache'), 'sourceDownloads': after.get('sourceDownloads'),
        'cacheBytes': after.get('cacheBytes'), 'transientResourcesReleased': released, 'transientResourcePeaks': peaks,
        'resources': resource_values,
    })

value = {
    'passed': raw['passed'], 'binarySHA256': raw['binarySHA256'], 'configuration': raw['configuration'],
    'phases': phases, 'dataConsistencyVerified': True, 'inputFiles': inputs,
    'totalPlannedAttempts': sum(phase['plannedAttempts'] for phase in phases),
    'totalAttempts': sum(phase['attempted'] for phase in phases),
    'totalUnrecordedAttempts': sum(phase['unrecordedAttempts'] for phase in phases),
    'totalWholeCorrectResponses': sum(phase['wholeCorrectResponses'] for phase in phases),
    'totalFailed': sum(phase['failed'] for phase in phases),
    'activeResources': resources(all_active_samples),
    'methodology': 'All denominators and nearest-rank P95 values recomputed from the preserved outcomes. Native active samples run from burst creation through complete verification; CPU uses sampled one-second intervals and can straddle a phase boundary. Full original hashes are checked after the paced window is drained. No claim about OS cold caches, WAN capacity or actual sound output.',
    'independentAudit': False,
}
assert value['passed'] == all(item['passed'] for item in raw['checks'])
(root / 'cold-users-summary.json').write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({key: value[key] for key in ['passed', 'totalAttempts', 'totalUnrecordedAttempts', 'totalWholeCorrectResponses', 'totalFailed']}))
