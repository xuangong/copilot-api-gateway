"""Read-only Darwin process accounting. Never reads argv or environment values."""

import ctypes
import errno
import json
import os
import sys
import time


class RusageInfoV2(ctypes.Structure):
    # Darwin SDK sys/resource.h, RUSAGE_INFO_V2. CPU fields use Mach absolute
    # units (not nanoseconds on Apple Silicon), as does start_abstime.
    # XNU osfmk/kern/bsd_kern.c fill_task_rusage copies task power CPU counters.
    _fields_ = [("ri_uuid", ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64)
        for name in (
            "ri_user_time", "ri_system_time", "ri_pkg_idle_wkups",
            "ri_interrupt_wkups", "ri_pageins", "ri_wired_size",
            "ri_resident_size", "ri_phys_footprint", "ri_proc_start_abstime",
            "ri_proc_exit_abstime", "ri_child_user_time", "ri_child_system_time",
            "ri_child_pkg_idle_wkups", "ri_child_interrupt_wkups",
            "ri_child_pageins", "ri_child_elapsed_abstime",
            "ri_diskio_bytesread", "ri_diskio_byteswritten",
        )
    ]


class MachTimebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


class DarwinProbe:
    def __init__(self):
        if sys.platform != "darwin":
            raise RuntimeError("Process resource probe supports Darwin only")
        self.lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        self.lib.proc_pid_rusage.restype = ctypes.c_int
        self.lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        self.lib.proc_pidpath.restype = ctypes.c_int
        self.lib.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_listchildpids.restype = ctypes.c_int
        self.system = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        self.system.mach_timebase_info.argtypes = [ctypes.POINTER(MachTimebase)]
        self.system.mach_timebase_info.restype = ctypes.c_int
        self.timebase = MachTimebase()
        if self.system.mach_timebase_info(ctypes.byref(self.timebase)) != 0 or self.timebase.denom == 0:
            raise RuntimeError("Cannot read Mach CPU timebase")

    def cpu_us(self, absolute_time):
        return absolute_time * self.timebase.numer // (self.timebase.denom * 1_000)

    @staticmethod
    def fail(operation, pid):
        code = ctypes.get_errno()
        raise OSError(code, f"{operation} failed for PID {pid}: {os.strerror(code)}")

    def usage(self, pid):
        result = RusageInfoV2()
        if self.lib.proc_pid_rusage(pid, 2, ctypes.byref(result)) != 0:
            self.fail("proc_pid_rusage", pid)
        if result.ri_proc_start_abstime == 0 or result.ri_proc_exit_abstime != 0:
            raise RuntimeError(f"PID {pid} has no live process identity")
        return result

    def sample(self, pid):
        before = self.usage(pid)
        path = ctypes.create_string_buffer(4096)
        if self.lib.proc_pidpath(pid, path, len(path)) <= 0:
            self.fail("proc_pidpath", pid)
        after = self.usage(pid)
        observed_at_ms = time.monotonic_ns() / 1_000_000
        if (
            before.ri_proc_start_abstime != after.ri_proc_start_abstime
            or bytes(before.ri_uuid) != bytes(after.ri_uuid)
            or after.ri_user_time < before.ri_user_time
            or after.ri_system_time < before.ri_system_time
        ):
            raise RuntimeError(f"PID {pid} changed identity during sampling")
        return {
            "pid": pid,
            "startIdentity": f"darwin-abstime:{after.ri_proc_start_abstime}",
            "executableName": os.path.basename(os.fsdecode(path.value)),
            "userUs": self.cpu_us(after.ri_user_time),
            "systemUs": self.cpu_us(after.ri_system_time),
            "rssBytes": after.ri_resident_size,
            "observedAtMs": observed_at_ms,
            "scope": "darwin-process-libproc-rusage-v2",
        }

    def children(self, pid):
        ctypes.set_errno(0)
        count = self.lib.proc_listchildpids(pid, None, 0)
        if count < 0 or (count == 0 and ctypes.get_errno() != 0):
            self.fail("proc_listchildpids", pid)
        for _ in range(3):
            capacity = count + 64
            buffer = (ctypes.c_int * capacity)()
            ctypes.set_errno(0)
            used = self.lib.proc_listchildpids(pid, buffer, ctypes.sizeof(buffer))
            if used < 0 or (used == 0 and ctypes.get_errno() != 0):
                self.fail("proc_listchildpids", pid)
            # Unlike proc_listpids, this wrapper returns a PID count, not bytes.
            if used < capacity:
                return [buffer[index] for index in range(used) if buffer[index] > 0]
            count = used * 2
        raise RuntimeError(f"PID {pid} descendants changed too quickly to enumerate")

    def descendants(self, owner_pid):
        owner = self.sample(owner_pid)
        pending = [(owner, ())]
        seen = set()
        matches = []
        while pending:
            parent, chain = pending.pop()
            pid = parent["pid"]
            if pid in seen or len(seen) >= 4096 or len(chain) >= 64:
                raise RuntimeError("Process tree is cyclic or exceeds the bounded discovery limit")
            seen.add(pid)
            next_chain = chain + ((pid, parent["startIdentity"]),)
            for child_pid in self.children(pid):
                try:
                    child = self.sample(child_pid)
                except OSError as error:
                    if error.errno in (errno.ESRCH, errno.ENOENT):
                        continue
                    raise
                if child["executableName"] == "workerd":
                    matches.append((child, next_chain))
                pending.append((child, next_chain))
        return owner, matches

    def discover(self, owner_pid):
        owner, matches = self.descendants(owner_pid)
        if not matches:
            raise RuntimeError(f"No workerd descendant of owner PID {owner_pid}")
        if len(matches) != 1:
            pids = ", ".join(str(match[0]["pid"]) for match in matches)
            raise RuntimeError(f"Multiple workerd descendants of owner PID {owner_pid}: {pids}")
        verified_owner, verified = self.descendants(owner_pid)
        match, chain = matches[0]
        if (
            verified_owner["startIdentity"] != owner["startIdentity"]
            or len(verified) != 1
            or verified[0][0]["pid"] != match["pid"]
            or verified[0][0]["startIdentity"] != match["startIdentity"]
            or verified[0][1] != chain
        ):
            raise RuntimeError("Owner/workerd identity or ancestry changed during discovery")
        return verified[0][0]


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("sample", "discover"):
        raise RuntimeError("Usage: process-resource-probe.py sample|discover PID")
    pid = int(sys.argv[2])
    if not 0 < pid <= 2_147_483_647:
        raise RuntimeError("PID must be a positive signed 32-bit integer")
    probe = DarwinProbe()
    result = probe.sample(pid) if sys.argv[1] == "sample" else probe.discover(pid)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
