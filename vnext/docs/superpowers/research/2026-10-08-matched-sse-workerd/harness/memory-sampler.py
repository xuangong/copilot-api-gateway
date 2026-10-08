"""Read-only RSS observer for one owned group; 20 ms requested, actual gaps recorded."""

import ctypes
import errno
import json
import os
from pathlib import Path
import runpy
import select
import signal
import sys
import time


def monotonic_ms():
    return time.monotonic_ns() / 1_000_000


class SamplingState:
    def __init__(self, owner_pid, owner_identity):
        self.owner_pid = owner_pid
        self.owner_identity = owner_identity
        self.sample_count = 0
        self.workerd = None
        self.last_at = None
        self.exited = False

    def observe(self, matches, at_ms):
        if len(matches) > 1:
            raise RuntimeError("Multiple workerd processes in the owned group")
        if not matches:
            if not self.workerd or self.exited:
                return []
            self.exited = True
            return [{"kind": "workerd-exited", **self.workerd, "atMs": at_ms}]
        if self.exited:
            raise RuntimeError("workerd reappeared after leaving the owned group")
        sample = matches[0]
        identity = {"pid": sample["pid"], "startIdentity": sample["startIdentity"]}
        if self.workerd and identity != self.workerd:
            raise RuntimeError("Sampled workerd identity changed")
        if self.last_at is not None and sample["observedAtMs"] <= self.last_at:
            raise RuntimeError("Memory sample timestamps regressed")
        self.workerd = identity
        self.last_at = sample["observedAtMs"]
        self.sample_count += 1
        return [{"kind": "sample", "resource": sample, "targetGroup": self.owner_pid, "ownerIdentity": self.owner_identity}]


class GroupProbe:
    def __init__(self, probe):
        self.probe = probe
        self.lib = probe.lib
        self.lib.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_listpids.restype = ctypes.c_int

    def pids(self, group):
        # Darwin SDK sys/proc_info.h: PROC_PGRP_ONLY=2. Unlike
        # proc_listchildpids, proc_listpids returns buffer bytes, not PID count.
        for capacity in (256, 1024, 4096):
            buffer = (ctypes.c_int * capacity)()
            used = self.lib.proc_listpids(2, group, buffer, ctypes.sizeof(buffer))
            if used < 0:
                self.probe.fail("proc_listpids", group)
            if used < ctypes.sizeof(buffer):
                if used % ctypes.sizeof(ctypes.c_int):
                    raise RuntimeError("Unaligned process group PID buffer")
                return sorted({buffer[index] for index in range(used // ctypes.sizeof(ctypes.c_int)) if buffer[index] > 0})
        raise RuntimeError("Owned group exceeds bounded discovery limit")

    def executable_name(self, pid):
        path = ctypes.create_string_buffer(4096)
        if self.lib.proc_pidpath(pid, path, len(path)) <= 0:
            self.probe.fail("proc_pidpath", pid)
        return os.path.basename(os.fsdecode(path.value))

    def workerd(self, owner_pid, owner_identity):
        owner = self.probe.sample(owner_pid)
        if owner["startIdentity"] != owner_identity or os.getpgid(owner_pid) != owner_pid:
            raise RuntimeError("Owned group coordinator identity changed")
        matches = []
        pids = self.pids(owner_pid)
        if owner_pid not in pids:
            raise RuntimeError("Owned group coordinator missing from process table")
        for pid in pids:
            if pid == owner_pid:
                continue
            try:
                # System helpers such as /bin/ps can deny rusage even though
                # their executable path is readable. Only sample workerd.
                if self.executable_name(pid) != "workerd":
                    continue
                sample = self.probe.sample(pid)
                if os.getpgid(pid) != owner_pid:
                    raise RuntimeError("Process left the owned group during sampling")
                if sample["executableName"] != "workerd":
                    raise RuntimeError("workerd candidate changed executable during sampling")
                matches.append(sample)
            except OSError as error:
                if error.errno in (errno.ESRCH, errno.ENOENT):
                    continue
                raise
        return matches


def main():
    if len(sys.argv) != 4:
        raise RuntimeError("Usage: memory-sampler.py OWNER_PID OWNER_START_IDENTITY TRACE_PATH")
    owner_pid = int(sys.argv[1])
    if not 0 < owner_pid <= 2_147_483_647 or os.getppid() != owner_pid:
        raise RuntimeError("Sampler must be spawned directly by its owned coordinator")
    if os.getpgid(0) != os.getpid() or os.getpgid(owner_pid) != owner_pid:
        raise RuntimeError("Sampler and coordinator require separate owned process groups")
    source = Path(__file__).resolve().parents[2] / "2026-10-07-reference-stage-measurement/harness/process-resource-probe.py"
    probe = runpy.run_path(str(source))["DarwinProbe"]()
    owner = probe.sample(owner_pid)
    if owner["startIdentity"] != sys.argv[2]:
        raise RuntimeError("Sampler coordinator identity mismatch")
    state = SamplingState(owner_pid, owner["startIdentity"])
    group = GroupProbe(probe)
    descriptor = os.open(sys.argv[3], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    requested_signal = []
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda received, _frame: requested_signal.append(received))
    error = None
    stopped = False
    remaining = []
    with os.fdopen(descriptor, "w", buffering=1) as output:
        def emit(event):
            output.write(json.dumps(event, separators=(",", ":")) + "\n")

        try:
            sampler = probe.sample(os.getpid())
            ready = {"kind": "ready", "schema": "sampled-rss-v1", "targetGroup": owner_pid, "owner": owner, "sampler": sampler, "samplerGroup": os.getpgid(0), "requestedIntervalMs": 20, "atMs": monotonic_ms()}
            emit(ready)
            print(json.dumps(ready), flush=True)
            next_at = time.monotonic()
            while True:
                if requested_signal:
                    raise RuntimeError("Sampler interrupted by signal")
                matches = group.workerd(owner_pid, owner["startIdentity"])
                remaining = [sample["pid"] for sample in matches]
                for event in state.observe(matches, monotonic_ms()):
                    emit(event)
                # Darwin may coalesce timers. Record actual timestamps and never
                # compensate for missed time with an immediate catch-up burst.
                next_at = max(next_at + 0.020, time.monotonic() + 0.020)
                readable, _, _ = select.select([sys.stdin], [], [], max(0, next_at - time.monotonic()))
                if readable:
                    command = sys.stdin.readline()
                    if command != "stop\n":
                        raise RuntimeError("Sampler owner pipe closed or sent an invalid command")
                    matches = group.workerd(owner_pid, owner["startIdentity"])
                    remaining = [sample["pid"] for sample in matches]
                    for event in state.observe(matches, monotonic_ms()):
                        emit(event)
                    if remaining or not state.workerd or not state.exited:
                        raise RuntimeError("Sampler stopped without a resolved workerd lifecycle")
                    stopped = True
                    break
        except (OSError, RuntimeError, ValueError) as failure:
            error = str(failure)
        finally:
            emit({"kind": "stopped", "atMs": monotonic_ms(), "completed": stopped and error is None, "error": error, "sampleCount": state.sample_count, "workerd": state.workerd, "remainingWorkerdPids": remaining, "ownerIdentity": owner["startIdentity"]})
            output.flush()
            os.fsync(output.fileno())
    if error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError) as failure:
        print(str(failure), file=sys.stderr)
        sys.exit(1)
