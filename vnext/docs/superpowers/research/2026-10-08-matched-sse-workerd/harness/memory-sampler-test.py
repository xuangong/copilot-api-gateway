import errno
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch

sampler = runpy.run_path(str(Path(__file__).with_name("memory-sampler.py")))
SamplingState = sampler["SamplingState"]
GroupProbe = sampler["GroupProbe"]


def resource(at=100, pid=42, identity="darwin-abstime:100"):
    return {"pid": pid, "startIdentity": identity, "executableName": "workerd", "observedAtMs": at, "rssBytes": 1024}


class SamplingStateTest(unittest.TestCase):
    def test_empty_start_is_waiting_but_first_workerd_is_sampled(self):
        state = SamplingState(7, "darwin-abstime:50")
        self.assertEqual(state.observe([], 90), [])
        self.assertEqual(state.observe([resource()], 101), [{"kind": "sample", "resource": resource(), "targetGroup": 7, "ownerIdentity": "darwin-abstime:50"}])
        self.assertEqual(state.sample_count, 1)

    def test_multiple_workerd_processes_cannot_be_arbitrarily_selected(self):
        state = SamplingState(7, "darwin-abstime:50")
        with self.assertRaisesRegex(RuntimeError, "Multiple"):
            state.observe([resource(), resource(pid=43)], 101)

    def test_identity_reuse_and_clock_regression_are_rejected(self):
        for next_sample in [resource(120, identity="darwin-abstime:101"), resource(99)]:
            state = SamplingState(7, "darwin-abstime:50")
            state.observe([resource()], 101)
            with self.assertRaises(RuntimeError):
                state.observe([next_sample], 121)

    def test_disappearance_is_recorded_once_and_no_restart_is_accepted(self):
        state = SamplingState(7, "darwin-abstime:50")
        state.observe([resource()], 101)
        self.assertEqual(state.observe([], 120), [{"kind": "workerd-exited", "pid": 42, "startIdentity": "darwin-abstime:100", "atMs": 120}])
        self.assertEqual(state.observe([], 140), [])
        with self.assertRaisesRegex(RuntimeError, "reappeared"):
            state.observe([resource(160)], 161)


class GroupProbeTest(unittest.TestCase):
    def group(self, names, samples):
        class Probe:
            def sample(self, pid):
                value = samples[pid]
                if isinstance(value, Exception):
                    raise value
                return value

        group = object.__new__(GroupProbe)
        group.probe = Probe()
        group.pids = lambda _owner: [7, *names]

        def executable_name(pid):
            value = names[pid]
            if isinstance(value, Exception):
                raise value
            return value

        group.executable_name = executable_name
        return group

    def test_non_workerd_permission_error_does_not_block_the_measured_workerd(self):
        owner = {"startIdentity": "owner"}
        group = self.group({8: "ps", 42: "workerd"}, {7: owner, 8: OSError(errno.EPERM, "protected ps rusage"), 42: resource()})
        with patch("os.getpgid", return_value=7):
            self.assertEqual(group.workerd(7, "owner"), [resource()])

    def test_workerd_permission_error_still_fails_the_observation(self):
        group = self.group({42: "workerd"}, {7: {"startIdentity": "owner"}, 42: OSError(errno.EPERM, "workerd rusage denied")})
        with patch("os.getpgid", return_value=7), self.assertRaises(PermissionError):
            group.workerd(7, "owner")

    def test_unknown_executable_permission_error_cannot_be_silently_skipped(self):
        group = self.group({42: OSError(errno.EPERM, "executable identity denied")}, {7: {"startIdentity": "owner"}, 42: resource()})
        with patch("os.getpgid", return_value=7), self.assertRaises(PermissionError):
            group.workerd(7, "owner")

    def test_workerd_candidate_cannot_change_executable_during_sampling(self):
        group = self.group({42: "workerd"}, {7: {"startIdentity": "owner"}, 42: {**resource(), "executableName": "ps"}})
        with patch("os.getpgid", return_value=7), self.assertRaisesRegex(RuntimeError, "executable"):
            group.workerd(7, "owner")


if __name__ == "__main__":
    unittest.main()
