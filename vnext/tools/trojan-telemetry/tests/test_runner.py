import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from support import load_agent

agent = load_agent()

KEY = "tlm_" + "a" * 64
NOW = "2026-11-16T14:05:00Z"
HASH_A = agent.sha224_hex("pw1")


def line(user_hash, target, sent, recv, stamp):
    return ('time="%s" level=info msg="user %s from 1.2.3.4:5555 tunneling to %s closed sent: %s recv: %s"'
            % (stamp, user_hash, target, sent, recv))


def vnstat_v2(rows):
    entries = [{"id": i, "date": {"year": y, "month": m, "day": d}, "time": {"hour": h, "minute": 0}, "rx": rx, "tx": tx}
               for i, (y, m, d, h, rx, tx) in enumerate(rows)]
    return json.dumps({"vnstatversion": "2.6", "jsonversion": "2", "interfaces": [{"name": "eth0", "traffic": {"hour": entries}}]})


class PushServer(object):
    """Records pushes and answers with scripted statuses (200 once the script runs out)."""

    def __init__(self, statuses=None):
        self.statuses = list(statuses or [])
        self.location = None
        self.accepted = None
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                outer.requests.append({"path": self.path, "auth": self.headers.get("Authorization"),
                                       "type": self.headers.get("Content-Type"), "body": json.loads(body.decode("utf-8"))})
                status = outer.statuses.pop(0) if outer.statuses else 200
                accepted = outer.accepted if outer.accepted is not None else len(outer.requests[-1]["body"]["points"])
                reply = json.dumps({"accepted": accepted}).encode("ascii")
                self.send_response(status)
                if outer.location:
                    self.send_header("Location", outer.location)
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

            def do_GET(self):
                outer.requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "type": None, "body": {"points": []}})
                reply = b'{"accepted":0}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class FakeRunner(object):
    """Stands in for docker and vnstat."""

    def __init__(self):
        self.calls = []
        self.logs = {}
        self.fail_since = set()
        self.vnstat = vnstat_v2([])
        self.vnstat_code = 0

    def __call__(self, args, timeout=300):
        self.calls.append(list(args))
        if args[0] == "vnstat":
            return self.vnstat_code, self.vnstat if self.vnstat_code == 0 else "", "" if self.vnstat_code == 0 else "vnstat: failed"
        return 1, "", "unsupported"

    def stream_logs(self, args, user_map, timeout=300):
        """`logs[since]` is a string for stdout, or an (stdout, stderr) pair; both streams are parsed."""
        self.calls.append(list(args))
        since = args[3]
        if since in self.fail_since:
            return 1, {}, "Error: no such container"
        streams = self.logs.get(since, "")
        if isinstance(streams, str):
            streams = (streams, "")
        return 0, agent.parse_streams(user_map, [s.splitlines() for s in streams]), ""

    def since(self):
        return [call[3] for call in self.calls if call[:2] == ["docker", "logs"]]


class RunnerCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state_dir = os.path.join(self.tmp, "state")
        self.previous_tz = os.environ.get("TZ")
        os.environ["TZ"] = "UTC"
        time.tzset()
        self.addCleanup(self.restore_tz)
        patcher = mock.patch.object(agent, "DEFAULT_CONFIG_PATHS", [])
        patcher.start()
        self.addCleanup(patcher.stop)
        self.server = PushServer()
        self.addCleanup(self.close_server)
        self.runner = FakeRunner()
        self.env = {"TELEMETRY_GATEWAY": self.server.url, "TELEMETRY_KEY": KEY, "TROJAN_USERS": HASH_A}

    def restore_tz(self):
        if self.previous_tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = self.previous_tz
        time.tzset()

    def close_server(self):
        try:
            self.server.close()
        except Exception:
            pass

    def run_main(self, now=NOW, env=None):
        out = io.StringIO()
        with mock.patch.object(sys, "stdout", out), mock.patch.object(sys, "stderr", io.StringIO()):
            code = agent.main(["run", "--state-dir", self.state_dir, "--env-file", os.path.join(self.tmp, "none.env"), "--now", now],
                              environ=dict(self.env if env is None else env), runner=self.runner)
        return code, out.getvalue()

    def set_cursor(self, iso):
        os.makedirs(os.path.join(self.state_dir, "outbox"), exist_ok=True)
        with open(os.path.join(self.state_dir, "cursor.json"), "w") as handle:
            json.dump({"cursor": iso}, handle)

    def cursor(self):
        with open(os.path.join(self.state_dir, "cursor.json")) as handle:
            return json.load(handle)["cursor"]

    def outbox(self):
        return sorted(os.listdir(os.path.join(self.state_dir, "outbox")))


class CollectTest(RunnerCase):
    def test_catch_up_across_a_gap_processes_each_closed_hour_oldest_first_and_pushes_them(self):
        self.set_cursor("2026-11-16T09:00:00Z")
        self.runner.logs["2026-11-16T11:00:00Z"] = line(HASH_A, "www.google.com:443", "1.00 KiB", "2.00 KiB", "2026-11-16T11:30:00Z")
        code, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(self.runner.since(), ["2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z", "2026-11-16T12:00:00Z", "2026-11-16T13:00:00Z"])
        self.assertEqual(len(self.server.requests), 1)
        request = self.server.requests[0]
        self.assertEqual((request["path"], request["auth"], request["type"]), ("/api/telemetry/push", "Bearer " + KEY, "application/json"))
        self.assertEqual(request["body"]["version"], 1)
        self.assertEqual(sorted(set(p["hour"] for p in request["body"]["points"])), ["2026-11-16T11:00:00Z"])
        self.assertEqual(self.cursor(), "2026-11-16T13:00:00Z")
        self.assertEqual(self.outbox(), [])

    def test_each_hour_is_fetched_with_absolute_utc_since_and_until_even_in_another_timezone(self):
        os.environ["TZ"] = "Asia/Shanghai"
        time.tzset()
        self.set_cursor("2026-11-16T11:00:00Z")
        self.env["TROJAN_CONTAINER"] = "ctr"
        self.assertEqual(self.run_main()[0], 0)
        docker = [call for call in self.runner.calls if call[:2] == ["docker", "logs"]]
        self.assertEqual(docker, [
            ["docker", "logs", "--since", "2026-11-16T12:00:00Z", "--until", "2026-11-16T13:00:00Z", "--", "ctr"],
            ["docker", "logs", "--since", "2026-11-16T13:00:00Z", "--until", "2026-11-16T14:00:00Z", "--", "ctr"],
        ])

    def test_lines_from_both_stdout_and_stderr_are_counted(self):
        self.set_cursor("2026-11-16T11:00:00Z")
        self.runner.logs["2026-11-16T12:00:00Z"] = (
            line(HASH_A, "a.example.com:443", "1.00 KiB", "0 B", "2026-11-16T12:10:00Z"),
            line(HASH_A, "a.example.com:443", "2.00 KiB", "0 B", "2026-11-16T12:20:00Z"))
        self.assertEqual(self.run_main()[0], 0)
        sent = [p for p in self.server.requests[0]["body"]["points"] if p["metric"] == "proxy.sent_bytes"]
        connections = [p for p in self.server.requests[0]["body"]["points"] if p["metric"] == "proxy.connections"]
        self.assertEqual([p["value"] for p in sent], [3072])
        self.assertEqual([p["value"] for p in connections], [2])

    def test_a_first_run_backfills_24_hours_and_empty_hours_still_push(self):
        code, _ = self.run_main()
        self.assertEqual(code, 0)
        since = self.runner.since()
        self.assertEqual((len(since), since[0], since[-1]), (24, "2026-11-15T14:00:00Z", "2026-11-16T13:00:00Z"))
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.server.requests[0]["body"], {"version": 1, "points": []})

    def test_a_cursor_older_than_7_days_is_clamped(self):
        self.set_cursor("2026-09-01T00:00:00Z")
        cfg = agent.Config(self.env)
        state = agent.State(self.state_dir)
        state.ensure()
        agent.collect(cfg, state, {}, self.runner, agent.parse_iso(NOW))
        names = self.outbox()
        self.assertEqual((len(names), names[0], names[-1]), (168, "2026-11-09T14.json", "2026-11-16T13.json"))

    def test_a_docker_failure_stops_the_loop_without_advancing_the_cursor(self):
        self.set_cursor("2026-11-16T09:00:00Z")
        self.runner.fail_since = {"2026-11-16T12:00:00Z"}
        code, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(self.runner.since(), ["2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z", "2026-11-16T12:00:00Z"])
        self.assertEqual(self.cursor(), "2026-11-16T11:00:00Z")
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.outbox(), [])

    def test_a_vnstat_failure_stops_before_anything_is_recorded(self):
        self.runner.vnstat_code = 1
        code, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertFalse(os.path.exists(os.path.join(self.state_dir, "cursor.json")))
        self.assertEqual(self.outbox(), [])
        self.assertEqual(self.server.requests, [])

    def test_a_missing_vnstat_row_is_not_a_failure(self):
        self.set_cursor("2026-11-16T09:00:00Z")
        self.runner.vnstat = vnstat_v2([(2026, 11, 16, 11, 100, 200)])
        code, _ = self.run_main()
        self.assertEqual(code, 0)
        points = self.server.requests[0]["body"]["points"]
        self.assertEqual(sorted((p["metric"], p["hour"], p["value"]) for p in points),
                         [("nic.rx_bytes", "2026-11-16T11:00:00Z", 100), ("nic.tx_bytes", "2026-11-16T11:00:00Z", 200)])
        self.assertTrue(all(p["unit"] == "bytes" and "dims" not in p for p in points))

    def test_the_outbox_file_exists_before_the_cursor_moves(self):
        self.set_cursor("2026-11-16T12:00:00Z")
        with mock.patch.object(agent.State, "write_cursor", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.run_main()
        self.assertEqual(self.outbox(), ["2026-11-16T13.json"])
        self.assertEqual(self.cursor(), "2026-11-16T12:00:00Z")

    def test_nothing_is_left_half_written(self):
        self.run_main()
        self.assertEqual(sorted(os.listdir(self.state_dir)), ["cursor.json", "lock", "outbox"])


class PushSafetyTest(RunnerCase):
    def test_a_redirect_is_a_failure_and_the_key_never_reaches_the_target(self):
        target = PushServer()
        self.addCleanup(target.close)
        self.server.statuses = [301]
        self.server.location = target.url + "/api/telemetry/push"
        self.set_cursor("2026-11-16T11:00:00Z")
        code, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(target.requests, [])
        self.assertEqual(self.outbox(), ["2026-11-16T12.json", "2026-11-16T13.json"])

    def test_every_redirect_status_fails(self):
        for status in (302, 303, 307, 308):
            target = PushServer()
            self.addCleanup(target.close)
            self.server.statuses = [status]
            self.server.location = target.url + "/x"
            self.set_cursor("2026-11-16T11:00:00Z")
            self.assertEqual(self.run_main()[0], 1, status)
            self.assertEqual(target.requests, [])

    def test_a_200_whose_accepted_count_differs_is_a_failure(self):
        self.server.accepted = 7
        self.set_cursor("2026-11-16T12:00:00Z")
        self.run_main()
        self.server.requests[:] = []
        code, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(self.outbox(), ["2026-11-16T13.json"])

    def test_a_200_without_a_json_reply_is_a_failure(self):
        cfg = agent.Config(self.env)
        with mock.patch.object(agent.urllib.request.OpenerDirector, "open") as opened:
            opened.return_value.__enter__.return_value.status = 200
            opened.return_value.__enter__.return_value.read.return_value = b"<html>"
            self.assertNotEqual(agent.post_points(cfg, []), 200)

    def test_only_https_or_loopback_gateways_are_accepted(self):
        for url in ("http://example.com", "ftp://example.com", "example.com", "http://127.0.0.1.evil.com"):
            with self.assertRaises(agent.ConfigError):
                agent.Config(dict(self.env, TELEMETRY_GATEWAY=url))
        for url in ("https://gw.example.com", "http://127.0.0.1:8080", "http://localhost:3000/", "https://gw.example.com/base"):
            agent.Config(dict(self.env, TELEMETRY_GATEWAY=url))
        agent.Config(dict(self.env, TELEMETRY_GATEWAY="http://[::1]:8080"))

    def test_a_gateway_url_with_a_query_or_fragment_is_a_config_error(self):
        for url in ("https://gw.example.com?x=1", "https://gw.example.com/base?x=1", "https://gw.example.com/#frag", "http://127.0.0.1:8080/?a"):
            with self.assertRaises(agent.ConfigError, msg=url):
                agent.Config(dict(self.env, TELEMETRY_GATEWAY=url))

    def test_the_http_error_is_closed_before_its_status_is_returned(self):
        cfg = agent.Config(self.env)
        exc = agent.urllib.error.HTTPError("http://x", 503, "unavailable", {}, None)
        exc.close = mock.Mock()
        with mock.patch.object(agent.urllib.request.OpenerDirector, "open", side_effect=exc):
            self.assertEqual(agent.post_points(cfg, []), 503)
        exc.close.assert_called_once_with()


class HardeningTest(RunnerCase):
    def test_non_ascii_hosts_become_invalid_and_ascii_domains_are_clamped(self):
        lines = [line(HASH_A, host + ":443", "1 B", "1 B", "t") for host in ("\U0001F600" * 200 + ".com", "\u4f8b\u3048.jp", "a.example.com")]
        totals = agent.parse_log_text(lines, {HASH_A: "#1"})
        self.assertEqual(sorted(totals), [("#1", "(invalid)"), ("#1", "example.com")])
        self.assertEqual(totals[("#1", "(invalid)")][2], 2)

    def test_unknown_units_are_skipped_on_stdout_and_stderr_without_a_crash(self):
        bad = line(HASH_A, "a.example.com:1", "1 iB", "1 B", "t")
        good = line(HASH_A, "b.example.com:1", "1 KB", "1 B", "t")
        self.assertEqual(agent.parse_log_text([bad, good], {HASH_A: "#1"}), {("#1", "example.com"): [1024, 1, 1]})
        child = StreamLogsTest("test_a_missing_program_is_127").child
        child.__self__.tmp = self.tmp
        code, totals, _ = agent.stream_logs(child([bad, good], [bad, good]), {HASH_A: "#1"})
        self.assertEqual((code, totals), (0, {("#1", "example.com"): [2048, 2, 2]}))

    def test_a_failure_in_the_stderr_reader_becomes_a_collect_error(self):
        class Exploding(object):
            def __init__(self, real):
                self.real = real

            def search(self, text):
                if "BOOM" in text:
                    raise ValueError("boom")
                return self.real.search(text)

        child = StreamLogsTest("test_a_missing_program_is_127")
        child.tmp = self.tmp
        with mock.patch.object(agent, "LOG_LINE", Exploding(agent.LOG_LINE)):
            with self.assertRaises(agent.CollectError):
                agent.stream_logs(child.child([], ["BOOM"]), {})

    def test_the_container_name_follows_a_double_dash(self):
        cfg = agent.Config(dict(self.env, TROJAN_CONTAINER="--all"))
        args = agent.docker_logs_args(cfg, agent.parse_iso("2026-11-16T13:00:00Z"))
        self.assertEqual(args[-2:], ["--", "--all"])

    def test_probe_target_is_validated(self):
        for target in ("a" * 64 + ".com:80", ("a" * 60 + ".") * 5 + "com:80", "host", "host:0", "host:70000", ":80", "\u00e9" * 300 + ".com:80"):
            with self.assertRaises(agent.ConfigError, msg=target):
                agent.Config(dict(self.env, PROBE_TARGET=target))
        self.assertEqual(agent.Config(dict(self.env, PROBE_TARGET="www.gstatic.com:80")).probe_target, "www.gstatic.com:80")
        agent.Config(dict(self.env, PROBE_TARGET="[2001:db8::1]:80"))

    def test_stale_temporary_files_are_removed_but_only_while_holding_the_lock(self):
        os.makedirs(os.path.join(self.state_dir, "outbox"))
        stale = [os.path.join(self.state_dir, "cursor.json.old.tmp"), os.path.join(self.state_dir, "outbox", "2026-01-01T00.json.tmp")]
        for path in stale:
            with open(path, "w") as handle:
                handle.write("{")
        held = agent.acquire_lock(self.state_dir)
        self.run_main()
        self.assertTrue(all(os.path.exists(p) for p in stale))
        os.close(held)
        self.run_main()
        self.assertFalse(any(os.path.exists(p) for p in stale))


class StreamLogsTest(RunnerCase):
    def child(self, out_lines, err_lines, code=0):
        script = os.path.join(self.tmp, "child.py")
        with open(script, "w") as handle:
            handle.write("import sys\nfor l in %r: sys.stdout.write(l + '\\n')\nfor l in %r: sys.stderr.write(l + '\\n')\nsys.exit(%d)\n"
                         % (out_lines, err_lines, code))
        return [sys.executable, script]

    def test_both_streams_of_a_real_process_are_parsed_and_merged(self):
        out = [line(HASH_A, "a.example.com:1", "1 KiB", "1 KiB", "t")] * 3
        err = [line(HASH_A, "b.example.com:1", "1 KiB", "1 KiB", "t")] * 2 + ["noise"]
        code, totals, _ = agent.stream_logs(self.child(out, err), {HASH_A: "#1"})
        self.assertEqual(code, 0)
        self.assertEqual(totals, {("#1", "example.com"): [5120, 5120, 5]})

    def test_a_large_stderr_does_not_block_and_failures_report_the_tail(self):
        err = ["x" * 100] * 20000 + ["boom"]
        code, totals, tail = agent.stream_logs(self.child([], err, 3), {})
        self.assertEqual((code, totals), (3, {}))
        self.assertIn("boom", tail)

    def test_a_missing_program_is_127(self):
        self.assertEqual(agent.stream_logs(["/nonexistent/docker-xyz"], {})[0], 127)

    def test_the_system_runner_streams_logs_from_docker(self):
        self.assertTrue(callable(getattr(agent.SystemRunner(), "stream_logs")))


class VnstatTest(RunnerCase):
    def test_v2_is_bytes_and_v1_is_kib(self):
        hour = agent.parse_iso("2026-11-16T13:00:00Z")
        self.assertEqual(agent.parse_vnstat(vnstat_v2([(2026, 11, 16, 13, 1000, 2000)]), "eth0"), {hour: (1000, 2000)})
        v1 = json.dumps({"vnstatversion": "1.18", "jsonversion": "1.2", "interfaces": [
            {"id": "eth0", "nick": "eth0", "traffic": {"hours": [{"id": 13, "date": {"year": 2026, "month": 11, "day": 16}, "rx": 1, "tx": 2}]}}]})
        self.assertEqual(agent.parse_vnstat(v1, "eth0"), {hour: (1024, 2048)})
        self.assertEqual(agent.parse_vnstat(vnstat_v2([(2026, 11, 16, 13, 1, 2)]), "wlan0"), {})
        with self.assertRaises(agent.CollectError):
            agent.parse_vnstat("not json", "eth0")

    def test_local_time_hours_are_converted_to_utc(self):
        os.environ["TZ"] = "Asia/Shanghai"
        time.tzset()
        parsed = agent.parse_vnstat(vnstat_v2([(2026, 11, 16, 21, 5, 6)]), "eth0")
        self.assertEqual(list(parsed), [agent.parse_iso("2026-11-16T13:00:00Z")])


class VnstatTimestampTest(RunnerCase):
    def test_a_timestamp_field_wins_over_local_date_and_time(self):
        os.environ["TZ"] = "America/New_York"
        time.tzset()
        epoch = agent.parse_iso("2026-11-01T06:00:00Z")  # the second 01:00, which mktime resolves to the first
        row = {"id": 1, "date": {"year": 2026, "month": 11, "day": 1}, "time": {"hour": 1, "minute": 0}, "timestamp": epoch, "rx": 3, "tx": 4}
        text = json.dumps({"jsonversion": "2", "interfaces": [{"name": "eth0", "traffic": {"hour": [row]}}]})
        self.assertEqual(agent.parse_vnstat(text, "eth0"), {epoch: (3, 4)})

    def test_without_a_timestamp_local_time_is_used(self):
        os.environ["TZ"] = "Asia/Shanghai"
        time.tzset()
        self.assertEqual(list(agent.parse_vnstat(vnstat_v2([(2026, 11, 16, 21, 1, 2)]), "eth0")), [agent.parse_iso("2026-11-16T13:00:00Z")])


class BatchTest(RunnerCase):
    def entries(self, hours, per_hour=1, probe_for=()):
        result = []
        base = agent.parse_iso("2026-11-10T00:00:00Z")
        for index in range(hours):
            epoch = base + index * 3600
            points = [agent.point("m", agent.iso_hour(epoch), {"k": str(i)}, 1, "count") for i in range(per_hour)]
            result.append((epoch, agent.hour_label(epoch) + ".json", points))
            if index in probe_for:
                result.append((epoch, agent.hour_label(epoch) + ".probe.json", [agent.point("probe.ok", agent.iso_hour(epoch), {}, 1, "count")]))
        return result

    def test_at_most_24_hours_per_batch_and_an_hours_probe_file_never_splits_from_it(self):
        batches = agent.plan_batches(self.entries(30, probe_for=(23, 24)))
        self.assertEqual([len(b["hours"]) for b in batches], [24, 6])
        self.assertEqual(sum(len(b["names"]) for b in batches), 32)
        self.assertIn("2026-11-10T23.probe.json", batches[0]["names"])
        self.assertIn("2026-11-11T00.probe.json", batches[1]["names"])

    def test_points_per_batch_are_capped_without_splitting_an_hour(self):
        batches = agent.plan_batches(self.entries(5, per_hour=4000))
        self.assertEqual([len(b["hours"]) for b in batches], [2, 2, 1])
        self.assertTrue(all(len(b["points"]) <= 10000 for b in batches))

    def test_the_body_size_is_capped_and_an_oversized_hour_travels_alone(self):
        with mock.patch.object(agent, "MAX_BATCH_BYTES", 1200):
            batches = agent.plan_batches(self.entries(4, per_hour=5))
            self.assertTrue(all(b["bytes"] <= 1200 or len(b["hours"]) == 1 for b in batches))
            self.assertGreater(len(batches), 1)
            self.assertEqual(sum(len(b["hours"]) for b in batches), 4)
            alone = agent.plan_batches(self.entries(1, per_hour=50))
            self.assertEqual([len(b["hours"]) for b in alone], [1])


class PushTest(RunnerCase):
    def test_a_failed_push_stops_the_rest_and_keeps_their_files(self):
        self.set_cursor("2026-11-16T10:00:00Z")
        self.server.statuses = [200, 500]
        with mock.patch.object(agent, "MAX_BATCH_HOURS", 1):
            code, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(len(self.server.requests), 2)
        self.assertEqual(self.outbox(), ["2026-11-16T12.json", "2026-11-16T13.json"])
        self.assertEqual(self.cursor(), "2026-11-16T13:00:00Z")

    def rejected(self):
        directory = os.path.join(self.state_dir, "outbox", "rejected")
        return sorted(os.listdir(directory)) if os.path.isdir(directory) else []

    def run_stderr(self):
        err = io.StringIO()
        with mock.patch.object(sys, "stderr", err), mock.patch.object(sys, "stdout", io.StringIO()):
            code = agent.main(["run", "--state-dir", self.state_dir, "--env-file", os.path.join(self.tmp, "none.env"), "--now", NOW],
                              environ=dict(self.env), runner=self.runner)
        return code, err.getvalue()

    def seed(self, hours, start="2026-11-16T11:00:00Z"):
        """Writes `hours` consecutive outbox hours from `start` and returns their epochs."""
        state = agent.State(self.state_dir)
        state.ensure()
        self.set_cursor("2026-11-16T13:00:00Z")
        epochs = [agent.parse_iso(start) + i * 3600 for i in range(hours)]
        for epoch in epochs:
            state.write_outbox(epoch, [agent.point("m", agent.iso_hour(epoch), {}, 1, "count")], False)
        return epochs

    def script(self, bad_hours, fail_after=None):
        """Answers 400 for any request containing a bad hour (by label), 200 otherwise; the nth request (1-based) gets 500 when fail_after is n."""
        bad = set(agent.iso_hour(agent.parse_hour_label(h)) for h in bad_hours)
        outer = self.server

        def status_for(index):
            if fail_after == index:
                return 500
            hours = set(p["hour"] for p in outer.requests[index - 1]["body"]["points"])
            return 400 if hours & bad else 200
        original = outer.requests

        class Statuses(list):
            def pop(inner, _index=0):
                return status_for(len(original))
            def __bool__(inner):
                return True
        outer.statuses = Statuses()

    def test_a_systemic_refusal_costs_two_requests_and_quarantines_nothing(self):
        self.seed(30, "2026-11-10T00:00:00Z")
        self.server.statuses = [400] * 50
        code, err = self.run_stderr()
        self.assertEqual(code, 1)
        self.assertEqual(len(self.server.requests), 2)
        self.assertEqual(self.rejected(), [])
        self.assertIn("systemic", err)
        self.assertEqual(len(self.outbox()), 30)

    def test_a_systemic_refusal_with_a_413_canary_is_also_systemic(self):
        self.seed(3, "2026-11-16T09:00:00Z")
        self.server.statuses = [413, 413]
        code, _ = self.run_stderr()
        self.assertEqual((code, len(self.server.requests), self.rejected()), (1, 2, []))
        self.assertEqual(len(self.outbox()), 3)

    def test_the_canary_is_the_newest_hour_with_hourly_data_not_a_probe_only_open_hour(self):
        epochs = self.seed(5, "2026-11-16T09:00:00Z")
        state = agent.State(self.state_dir)
        open_hour = agent.parse_iso("2026-11-16T14:00:00Z")
        state.write_outbox(open_hour, [agent.point("probe.ok", agent.iso_hour(open_hour), {}, 1, "count")], True)
        outer = self.server

        def status_for(index):
            metrics = set(p["metric"] for p in outer.requests[index - 1]["body"]["points"])
            return 400 if metrics - {"probe.ok"} else 200

        class Statuses(list):
            def pop(inner, _index=0):
                return status_for(len(outer.requests))

            def __bool__(inner):
                return True
        outer.statuses = Statuses()
        code, err = self.run_stderr()
        self.assertEqual(code, 1)
        self.assertLessEqual(len(self.server.requests), 2)
        self.assertEqual(self.rejected(), [])
        self.assertIn("systemic", err)
        self.assertEqual(len(self.outbox()), 6)
        self.assertEqual([p["hour"] for p in self.server.requests[1]["body"]["points"]], [agent.iso_hour(epochs[-1])])

    def test_a_lone_old_bad_hour_with_a_healthy_gateway_is_quarantined_and_the_rest_accepted(self):
        self.seed(5, "2026-11-16T05:00:00Z")
        self.script(["2026-11-16T07"])
        code, err = self.run_stderr()
        self.assertEqual(code, 1)
        self.assertEqual(self.rejected(), ["2026-11-16T07.json"])
        self.assertEqual(self.outbox(), ["rejected"])
        self.assertIn("2026-11-16T07", err)
        self.assertLessEqual(len(self.server.requests), 12)

    def test_a_single_old_hour_batch_refused_with_a_healthy_gateway_is_quarantined_after_one_canary(self):
        self.seed(3, "2026-11-16T04:00:00Z")
        self.script(["2026-11-16T04"])
        with mock.patch.object(agent, "MAX_BATCH_HOURS", 1):
            code, _ = self.run_stderr()
        self.assertEqual(code, 1)
        self.assertEqual(self.rejected(), ["2026-11-16T04.json"])
        self.assertEqual(self.outbox(), ["rejected"])
        self.assertEqual(len(self.server.requests), 3)

    def test_a_lone_bad_hour_that_is_also_the_only_and_newest_file_is_kept(self):
        self.seed(1, "2026-11-16T04:00:00Z")
        self.server.statuses = [400, 400]
        code, err = self.run_stderr()
        self.assertEqual(code, 1)
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.rejected(), [])
        self.assertEqual(self.outbox(), ["2026-11-16T04.json"])
        self.assertIn("systemic", err)

    def test_a_bad_hour_within_two_hours_of_the_clock_is_kept(self):
        self.seed(4, "2026-11-16T10:00:00Z")
        self.script(["2026-11-16T12"])
        code, err = self.run_stderr()
        self.assertEqual(code, 1)
        self.assertEqual(self.rejected(), [])
        self.assertEqual(self.outbox(), ["2026-11-16T12.json"])
        self.assertIn("recent", err)

    def test_bisection_finds_two_bad_hours_in_a_24_hour_batch_with_bounded_requests(self):
        self.seed(24, "2026-11-15T00:00:00Z")
        self.script(["2026-11-15T05", "2026-11-15T17"])
        code, _ = self.run_stderr()
        self.assertEqual(code, 1)
        self.assertEqual(self.rejected(), ["2026-11-15T05.json", "2026-11-15T17.json"])
        self.assertEqual(self.outbox(), ["rejected"])
        self.assertLessEqual(len(self.server.requests), 20)
        self.assertEqual(self.server.requests[1]["body"]["points"][0]["hour"], "2026-11-15T23:00:00Z")

    def test_the_canary_is_sent_at_most_once_per_run(self):
        self.seed(6, "2026-11-15T00:00:00Z")
        self.script(["2026-11-15T01", "2026-11-15T04"])
        with mock.patch.object(agent, "MAX_BATCH_HOURS", 3):
            self.run_stderr()
        canaries = [r for r in self.server.requests if [p["hour"] for p in r["body"]["points"]] == ["2026-11-15T05:00:00Z"]]
        self.assertEqual(len(canaries), 1)
        self.assertEqual(self.rejected(), ["2026-11-15T01.json", "2026-11-15T04.json"])

    def test_a_non_400_failure_after_an_accepted_canary_stops_and_keeps_the_rest(self):
        self.seed(4, "2026-11-15T00:00:00Z")
        self.script(["2026-11-15T01"], fail_after=3)
        code, _ = self.run_stderr()
        self.assertEqual(code, 1)
        self.assertEqual(len(self.server.requests), 3)
        self.assertNotIn("2026-11-15T03.json", self.outbox())
        self.assertEqual(self.rejected(), [])
        self.assertEqual(self.outbox(), ["2026-11-15T00.json", "2026-11-15T01.json", "2026-11-15T02.json"])

    def test_a_non_400_failure_on_the_canary_stops_and_keeps_everything(self):
        self.seed(3, "2026-11-15T00:00:00Z")
        self.server.statuses = [400, 503]
        code, _ = self.run_stderr()
        self.assertEqual((code, len(self.server.requests), self.rejected()), (1, 2, []))
        self.assertEqual(len(self.outbox()), 3)

    def test_a_quarantine_that_cannot_be_written_keeps_the_files_and_stops(self):
        self.seed(3)
        with open(os.path.join(self.state_dir, "outbox", "rejected"), "w") as handle:
            handle.write("in the way")
        self.script(["2026-11-16T11"])
        code, err = self.run_stderr()
        self.assertEqual(code, 1)
        self.assertIn("could not quarantine 2026-11-16T11", err)
        self.assertIn("keeping the remaining files", err)
        self.assertIn("2026-11-16T11.json", self.outbox())

    def test_every_run_mentions_quarantined_hours_without_changing_the_exit_code(self):
        state = agent.State(self.state_dir)
        state.ensure()
        for hour in ("2026-11-10T08", "2026-11-12T09"):
            state.write_outbox(agent.parse_hour_label(hour), [], False)
            state.reject(hour + ".json")
        self.set_cursor("2026-11-16T13:00:00Z")
        code, err = self.run_stderr()
        self.assertEqual(code, 0)
        self.assertIn("2 hour(s) in outbox/rejected/ (oldest 2026-11-10T08:00:00Z); see docs", err)

    def test_401_404_and_5xx_on_a_batch_do_not_send_a_canary(self):
        for status in (401, 404, 503):
            self.set_cursor("2026-11-16T10:00:00Z")
            self.server.requests[:] = []
            self.server.statuses = [status]
            self.assertEqual(self.run_main()[0], 1)
            self.assertEqual(len(self.server.requests), 1)
            self.assertEqual(self.rejected(), [])
            self.assertEqual(self.outbox(), ["2026-11-16T11.json", "2026-11-16T12.json", "2026-11-16T13.json"])
            for name in self.outbox():
                os.remove(os.path.join(self.state_dir, "outbox", name))

    def test_quarantined_files_are_never_retried_and_expire_after_30_days(self):
        self.assertEqual(agent.REJECTED_MAX_AGE_DAYS, 30)
        state = agent.State(self.state_dir)
        state.ensure()
        state.write_outbox(agent.parse_iso("2026-11-16T10:00:00Z"), [], False)
        state.reject("2026-11-16T10.json")
        for hour in ("2026-10-17T13", "2026-10-17T14", "2026-10-25T09"):
            state.write_outbox(agent.parse_hour_label(hour), [], False)
            state.reject(hour + ".json")
        self.assertEqual(agent.load_outbox(state), [])
        agent.discard_expired(state, agent.parse_iso(NOW))
        self.assertEqual(self.rejected(), ["2026-10-17T14.json", "2026-10-25T09.json", "2026-11-16T10.json"])
        self.assertEqual(self.server.requests, [])

    def test_an_unreachable_gateway_keeps_every_file_and_fails_the_run(self):
        self.server.close()
        self.set_cursor("2026-11-16T11:00:00Z")
        code, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(self.outbox(), ["2026-11-16T12.json", "2026-11-16T13.json"])

    def test_the_next_run_pushes_what_a_failed_run_kept(self):
        self.set_cursor("2026-11-16T11:00:00Z")
        self.server.statuses = [503]
        self.assertEqual(self.run_main()[0], 1)
        self.assertEqual(self.run_main()[0], 0)
        self.assertEqual(self.outbox(), [])
        self.assertEqual(sorted(set(p["hour"] for p in self.server.requests[-1]["body"]["points"])), [])
        self.assertEqual(len(self.server.requests), 2)

    def test_outbox_files_older_than_7_days_are_discarded_unpushed(self):
        self.assertEqual(agent.OUTBOX_MAX_AGE_DAYS, 7)
        state = agent.State(self.state_dir)
        state.ensure()
        state.write_outbox(agent.parse_iso("2026-11-09T13:00:00Z"), [], False)
        state.write_outbox(agent.parse_iso("2026-11-09T14:00:00Z"), [], False)
        agent.discard_expired(state, agent.parse_iso(NOW))
        self.assertEqual(self.outbox(), ["2026-11-09T14.json"])

    def test_an_unreadable_outbox_file_is_removed(self):
        state = agent.State(self.state_dir)
        state.ensure()
        with open(os.path.join(self.state_dir, "outbox", "2026-11-16T10.json"), "w") as handle:
            handle.write("{broken")
        self.assertEqual(agent.load_outbox(state), [])
        self.assertEqual(self.outbox(), [])


class CommandLineTest(RunnerCase):
    def test_a_held_lock_means_exit_zero_without_doing_anything(self):
        os.makedirs(self.state_dir)
        held = agent.acquire_lock(self.state_dir)
        self.assertIsNotNone(held)
        self.assertIsNone(agent.acquire_lock(self.state_dir))
        code, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(self.runner.calls, [])
        self.assertEqual(self.server.requests, [])
        os.close(held)
        again = agent.acquire_lock(self.state_dir)
        self.assertIsNotNone(again)
        os.close(again)

    def test_configuration_and_clock_errors_exit_two(self):
        self.assertEqual(self.run_main(env={"TELEMETRY_GATEWAY": self.server.url})[0], 2)
        self.assertEqual(self.run_main(now="yesterday")[0], 2)

    def test_the_env_file_supplies_the_configuration(self):
        env_path = os.path.join(self.tmp, "agent.env")
        with open(env_path, "w") as handle:
            handle.write("TELEMETRY_GATEWAY='%s'\nTELEMETRY_KEY='%s'\n" % (self.server.url, KEY))
        out = io.StringIO()
        with mock.patch.object(sys, "stdout", out), mock.patch.object(sys, "stderr", io.StringIO()):
            code = agent.main(["run", "--state-dir", self.state_dir, "--env-file", env_path, "--now", NOW], environ={}, runner=self.runner)
        self.assertEqual(code, 0)
        self.assertEqual(self.server.requests[0]["auth"], "Bearer " + KEY)

    def test_the_version_matches_the_version_file(self):
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "VERSION")) as handle:
            self.assertEqual(handle.read().strip(), agent.AGENT_VERSION)


if __name__ == "__main__":
    unittest.main()
