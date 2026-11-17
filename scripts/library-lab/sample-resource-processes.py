"""Read only Windows process and TCP counters; uses Python's standard library.

Usage: python sample-resource-processes.py OUTPUT STOP_FILE name:pid[:port] ...
Samples every second. A stop file ends sampling; PID creation times guard reuse.
No command lines, credentials, hostnames or remote addresses are recorded.
"""
import ctypes as c
from ctypes import wintypes as w
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import socket
import sys
import time

if sys.platform != 'win32':
    raise SystemExit('This sampler measures Windows APIs only.')
out, stop, *targets = sys.argv[1:]
kernel = c.WinDLL('kernel32', use_last_error=True)
psapi = c.WinDLL('psapi', use_last_error=True)
iphlp = c.WinDLL('iphlpapi', use_last_error=True)
kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
kernel.OpenProcess.restype = w.HANDLE
kernel.CloseHandle.argtypes = [w.HANDLE]
kernel.GetProcessTimes.argtypes = [w.HANDLE] + [c.POINTER(w.FILETIME)] * 4
kernel.GetProcessHandleCount.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
kernel.GetExitCodeProcess.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
kernel.GetSystemTimes.argtypes = [c.POINTER(w.FILETIME)] * 3

class Memory(c.Structure):
    _fields_ = [('cb', w.DWORD), ('PageFaultCount', w.DWORD)] + [(name, c.c_size_t) for name in
        ['PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage',
         'QuotaPeakNonPagedPoolUsage', 'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage', 'PrivateUsage']]

class Row(c.Structure):
    _fields_ = [(name, w.DWORD) for name in ['state', 'localAddr', 'localPort', 'remoteAddr', 'remotePort', 'pid']]

class SystemMemory(c.Structure):
    _fields_ = [('length', w.DWORD), ('load', w.DWORD)] + [(name, c.c_ulonglong) for name in
        ['totalPhysical', 'availablePhysical', 'totalPagefile', 'availablePagefile', 'totalVirtual', 'availableVirtual', 'availableExtendedVirtual']]

kernel.GlobalMemoryStatusEx.argtypes = [c.POINTER(SystemMemory)]

psapi.GetProcessMemoryInfo.argtypes = [w.HANDLE, c.POINTER(Memory), w.DWORD]
iphlp.GetExtendedTcpTable.argtypes = [c.c_void_p, c.POINTER(w.DWORD), w.BOOL, w.ULONG, c.c_int, w.ULONG]
states = {1: 'closed', 2: 'listen', 3: 'syn_sent', 4: 'syn_received', 5: 'established',
          6: 'fin_wait_1', 7: 'fin_wait_2', 8: 'close_wait', 9: 'closing', 10: 'last_ack', 11: 'time_wait', 12: 'delete_tcb'}

def tcp_rows():
    size = w.DWORD(0)
    iphlp.GetExtendedTcpTable(None, c.byref(size), False, 2, 5, 0)
    for _ in range(3):
        buf = c.create_string_buffer(size.value)
        result = iphlp.GetExtendedTcpTable(buf, c.byref(size), False, 2, 5, 0)
        if result == 122:
            continue
        if result:
            raise OSError('TCP counter query failed: ' + str(result))
        count = w.DWORD.from_buffer(buf).value
        rows = (Row * count).from_buffer(buf, c.sizeof(w.DWORD))
        values = {}
        for row in rows:
            record = values.setdefault(row.pid, {'states': {}, 'ports': {}})
            label = states.get(row.state, str(row.state))
            record['states'][label] = record['states'].get(label, 0) + 1
            port = socket.ntohs(row.localPort & 0xffff)
            port_record = record['ports'].setdefault(port, {})
            port_record[label] = port_record.get(label, 0) + 1
        return values
    raise OSError('TCP table changed during all retries')

def filetime(value):
    return (value.dwHighDateTime << 32) | value.dwLowDateTime

handles = []
for target in targets:
    name, pid, *ports = target.split(':')
    handle = kernel.OpenProcess(0x0410, False, int(pid))
    if not handle:
        raise OSError('Cannot read the requested process counters: ' + name)
    handles.append((name, int(pid), handle, int(ports[0]) if ports else None))
previous = {}
previous_system = None
try:
    with Path(out).open('x', encoding='utf-8') as stream:
        while not Path(stop).exists():
            started = time.perf_counter()
            values = tcp_rows()
            sample = {'recordedAt': datetime.now(timezone.utc).isoformat(), 'monotonicSeconds': started,
                      'counterClock': 'perf_counter', 'logicalProcessors': os.cpu_count(), 'processes': {}}
            idle_time, kernel_time, user_time = (w.FILETIME() for _ in range(3))
            if not kernel.GetSystemTimes(c.byref(idle_time), c.byref(kernel_time), c.byref(user_time)):
                raise OSError('System time query failed')
            system_idle = filetime(idle_time)
            system_total = filetime(kernel_time) + filetime(user_time)
            system_memory = SystemMemory(); system_memory.length = c.sizeof(system_memory)
            if not kernel.GlobalMemoryStatusEx(c.byref(system_memory)):
                raise OSError('System memory query failed')
            sample['system'] = {'availablePhysicalBytes': system_memory.availablePhysical, 'memoryLoadPercent': system_memory.load}
            if previous_system and system_total > previous_system[1]:
                sample['system']['cpuPercentBusy'] = 100 * (1 - (system_idle - previous_system[0]) / (system_total - previous_system[1]))
            previous_system = (system_idle, system_total)
            for name, pid, handle, server_port in handles:
                exit_code = w.DWORD()
                if not kernel.GetExitCodeProcess(handle, c.byref(exit_code)) or exit_code.value != 259:
                    sample['processes'][name] = {'pid': pid, 'exited': True}
                    continue
                created, exited, system, user = (w.FILETIME() for _ in range(4))
                if not kernel.GetProcessTimes(handle, c.byref(created), c.byref(exited), c.byref(system), c.byref(user)):
                    raise OSError('Process time query failed')
                memory = Memory(); memory.cb = c.sizeof(memory)
                if not psapi.GetProcessMemoryInfo(handle, c.byref(memory), memory.cb):
                    raise OSError('Memory counter query failed')
                handle_count = w.DWORD()
                if not kernel.GetProcessHandleCount(handle, c.byref(handle_count)):
                    raise OSError('Handle counter query failed')
                cpu = (filetime(system) + filetime(user)) / 1e7
                before = previous.get(name)
                record = {'pid': pid, 'createdFiletime': filetime(created), 'cpuSeconds': cpu,
                          'workingSetBytes': memory.WorkingSetSize, 'privateBytes': memory.PrivateUsage,
                          'handles': handle_count.value, 'tcp': values.get(pid, {}).get('states', {})}
                if server_port is not None:
                    record['serverTcp'] = values.get(pid, {}).get('ports', {}).get(server_port, {})
                if before:
                    record['cpuPercentOneCore'] = 100 * (cpu - before[1]) / (started - before[0])
                    record['cpuPercentMachine'] = record['cpuPercentOneCore'] / os.cpu_count()
                previous[name] = (started, cpu)
                sample['processes'][name] = record
            sample['samplingMilliseconds'] = (time.perf_counter() - started) * 1000
            stream.write(json.dumps(sample) + '\n'); stream.flush()
            time.sleep(max(0, 1 - (time.perf_counter() - started)))
finally:
    for _, _, handle, _ in handles:
        kernel.CloseHandle(handle)
