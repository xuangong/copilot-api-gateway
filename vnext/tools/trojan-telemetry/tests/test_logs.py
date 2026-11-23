import json
import os
import tempfile
import unittest
from unittest import mock

from support import load_agent

agent = load_agent()

HASH_A = agent.sha224_hex("pw1")
HASH_B = agent.sha224_hex("pw2")
USERS = {HASH_A: "#1", HASH_B: "#2"}


def line(user_hash, target, sent, recv, stamp="2026-11-16T13:05:12Z"):
    return ('time="%s" level=info msg="user %s from 1.2.3.4:5555 tunneling to %s closed sent: %s recv: %s"'
            % (stamp, user_hash, target, sent, recv))


class UnitsTest(unittest.TestCase):
    def test_log_units_are_1024_based(self):
        self.assertEqual(agent.to_bytes("1.50", "KiB"), 1536)
        self.assertEqual(agent.to_bytes("2", "MiB"), 2 * 1024 ** 2)
        self.assertEqual(agent.to_bytes("0.00", "B"), 0)
        self.assertEqual(agent.to_bytes("1", "GiB"), 1024 ** 3)
        self.assertEqual(agent.to_bytes("1", "TiB"), 1024 ** 4)
        self.assertEqual(agent.to_bytes("1", "KB"), 1024)


class ParseLogTest(unittest.TestCase):
    def test_lines_aggregate_by_user_and_registrable_domain(self):
        text = "\n".join([
            line(HASH_A, "www.google.com:443", "1.00 MiB", "2.00 MiB"),
            line(HASH_A, "mail.google.com:443", "1.00 MiB", "1.00 MiB"),
            line(HASH_B, "example.org:443", "512.00 KiB", "512.00 KiB"),
            "unrelated line", 'time="x" level=info msg="user abc from 1.2.3.4:1 tunneling to a.com:80"',
        ])
        totals = agent.parse_log_text(text, USERS)
        self.assertEqual(totals[("#1", "google.com")], [2 * 1024 ** 2, 3 * 1024 ** 2, 2])
        self.assertEqual(totals[("#2", "example.org")], [524288, 524288, 1])
        self.assertEqual(len(totals), 2)

    def test_targets_without_a_host_fold_into_unknown_and_never_an_empty_domain(self):
        text = "\n".join([line(HASH_A, ":443", "1.00 KiB", "1.00 KiB"), line(HASH_A, "noport", "1.00 KiB", "1.00 KiB")])
        totals = agent.parse_log_text(text, USERS)
        self.assertNotIn("", [domain for _, domain in totals])
        self.assertEqual(totals[("#1", "(unknown)")], [1024, 1024, 1])
        self.assertEqual(totals[("#1", "noport")], [1024, 1024, 1])
        self.assertEqual(len(totals), 2)

    def test_any_iterable_of_lines_is_accepted(self):
        lines = [line(HASH_A, "a.com:80", "1.00 KiB", "1.00 KiB")] * 2
        self.assertEqual(agent.parse_log_text(iter(lines), USERS)[("#1", "a.com")], [2048, 2048, 2])
        self.assertEqual(agent.parse_log_text(lines[0] + "\n" + lines[1] + "\n", USERS)[("#1", "a.com")], [2048, 2048, 2])

    def test_trojan_go_native_log_format_is_parsed(self):
        text = "[INFO]  2026/11/16 07:12:58 user %s from 1.2.3.4:5555 tunneling to www.google.com:443 closed sent: 1.50 KiB recv: 2 MiB" % HASH_A
        self.assertEqual(agent.parse_log_text(text, USERS)[("#1", "google.com")], [1536, 2 * 1024 ** 2, 1])

    def test_unknown_users_map_to_hash_question_mark_and_addresses_are_kept(self):
        text = "\n".join([
            line("f" * 56, "203.0.113.9:443", "1.00 KiB", "1.00 KiB"),
            line(HASH_A, "[2001:db8::1]:443", "1.00 KiB", "2.00 KiB"),
        ])
        totals = agent.parse_log_text(text, USERS)
        self.assertEqual(totals[("#?", "203.0.113.9")], [1024, 1024, 1])
        self.assertEqual(totals[("#1", "2001:db8::1")], [1024, 2048, 1])

    def test_a_hash_in_upper_case_still_maps(self):
        totals = agent.parse_log_text(line(HASH_A.upper(), "a.com:80", "1.00 B", "1.00 B"), USERS)
        self.assertIn(("#1", "a.com"), totals)


class DomainTest(unittest.TestCase):
    def test_registrable_domain_heuristic(self):
        cases = [
            ("www.google.com", "google.com"), ("example.com", "example.com"), ("a.b.c.example.co.uk", "example.co.uk"),
            ("bbc.co.uk", "bbc.co.uk"), ("foo.bar.com.cn", "bar.com.cn"), ("x.gov.au", "x.gov.au"), ("sub.example.de", "example.de"),
            ("a.co.jp", "a.co.jp"), ("localhost", "localhost"), ("EXAMPLE.COM.", "example.com"),
            ("203.0.113.9", "203.0.113.9"), ("2001:db8::1", "2001:db8::1"),
            # Known limit of the heuristic (no public suffix list): longer public suffixes group one level too coarse.
            ("foo.pvt.k12.ma.us", "ma.us"),
        ]
        for host, expected in cases:
            self.assertEqual(agent.registrable_domain(host), expected, host)


class TopTest(unittest.TestCase):
    def totals(self):
        return {
            ("#1", "a.com"): [10, 0, 1], ("#1", "b.com"): [30, 0, 3], ("#1", "c.com"): [20, 0, 2], ("#1", "d.com"): [5, 0, 1],
            ("#1", "e.com"): [5, 0, 4], ("#2", "z.com"): [1, 1, 1],
        }

    def test_domains_beyond_the_top_n_fold_into_other_per_user(self):
        folded = agent.fold_top(self.totals(), 2)
        self.assertEqual(folded[("#1", "b.com")], [30, 0, 3])
        self.assertEqual(folded[("#1", "c.com")], [20, 0, 2])
        self.assertEqual(folded[("#1", "(other)")], [20, 0, 6])
        self.assertEqual(folded[("#2", "z.com")], [1, 1, 1])
        self.assertEqual(len(folded), 4)

    def test_equal_totals_are_ordered_by_domain_and_nothing_folds_when_it_fits(self):
        self.assertEqual(agent.fold_top({("#1", "b.com"): [1, 0, 1], ("#1", "a.com"): [1, 0, 1]}, 1)[("#1", "a.com")], [1, 0, 1])
        self.assertNotIn(("#1", "(other)"), agent.fold_top(self.totals(), 10))

    def test_points_carry_four_proxy_metrics_with_user_and_domain_dims(self):
        hour = 1_794_000_000 - 1_794_000_000 % 3600
        points = agent.build_proxy_points(hour, {("#1", "a.com"): [10, 20, 2]}, 50)
        label = agent.iso_hour(hour)
        dims = {"user": "#1", "domain": "a.com"}
        self.assertEqual(points, [
            {"metric": "proxy.sent_bytes", "hour": label, "dims": dims, "value": 10, "unit": "bytes"},
            {"metric": "proxy.recv_bytes", "hour": label, "dims": dims, "value": 20, "unit": "bytes"},
            {"metric": "proxy.total_bytes", "hour": label, "dims": dims, "value": 30, "unit": "bytes"},
            {"metric": "proxy.connections", "hour": label, "dims": dims, "value": 2, "unit": "count"},
        ])

    def test_an_hour_is_tightened_until_it_fits_one_batch(self):
        totals = {("#1", "d%02d.com" % i): [i + 1, 0, 1] for i in range(10)}
        with mock.patch.object(agent, "MAX_BATCH_POINTS", 12):
            points = agent.build_proxy_points(0, totals, 10)
        self.assertEqual(len(points), 12)
        self.assertIn("(other)", [p["dims"]["domain"] for p in points])


class UsersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.config = os.path.join(self.tmp, "config.json")
        with open(self.config, "w") as handle:
            json.dump({"password": ["pw1", "pw2"]}, handle)

    def cfg(self, **extra):
        env = {"TELEMETRY_GATEWAY": "https://gw", "TELEMETRY_KEY": "tlm_x"}
        env.update(extra)
        return agent.Config(env)

    def test_passwords_in_file_order_become_numbered_users(self):
        users, passwords = agent.build_user_map(self.cfg(TROJAN_CONFIG=self.config), lambda *a, **k: (1, "", ""))
        self.assertEqual(users, {HASH_A: "#1", HASH_B: "#2"})
        self.assertEqual(passwords, ["pw1", "pw2"])

    def test_trojan_users_wins_and_keeps_its_order(self):
        users, passwords = agent.build_user_map(self.cfg(TROJAN_CONFIG=self.config, TROJAN_USERS="AAA, bbb\nccc"), lambda *a, **k: (1, "", ""))
        self.assertEqual(users, {"aaa": "#1", "bbb": "#2", "ccc": "#3"})
        self.assertEqual(passwords, ["pw1", "pw2"])

    def test_the_config_is_found_through_docker_bind_mounts(self):
        mounts = json.dumps([{"Source": "/nowhere", "Destination": "/data"}, {"Source": self.tmp, "Destination": "/etc/trojan-go"}])
        calls = []

        def runner(args, timeout=300):
            calls.append(args)
            return 0, mounts, ""

        self.assertEqual(agent.find_config_path(self.cfg(), runner), self.config)
        self.assertEqual(calls[0][:2], ["docker", "inspect"])
        file_mount = json.dumps([{"Source": self.config, "Destination": "/etc/trojan-go/config.json"}])
        self.assertEqual(agent.find_config_path(self.cfg(), lambda *a, **k: (0, file_mount, "")), self.config)

    def test_default_locations_are_the_last_resort_and_a_missing_config_is_not_fatal(self):
        with mock.patch.object(agent, "DEFAULT_CONFIG_PATHS", [os.path.join(self.tmp, "missing.json"), self.config]):
            self.assertEqual(agent.find_config_path(self.cfg(), lambda *a, **k: (1, "", "")), self.config)
        with mock.patch.object(agent, "DEFAULT_CONFIG_PATHS", [os.path.join(self.tmp, "missing.json")]):
            self.assertIsNone(agent.find_config_path(self.cfg(), lambda *a, **k: (1, "", "")))
            self.assertEqual(agent.build_user_map(self.cfg(), lambda *a, **k: (1, "", "")), ({}, []))


class ConfigTest(unittest.TestCase):
    def test_defaults_and_overrides(self):
        cfg = agent.Config({"TELEMETRY_GATEWAY": "https://gw.example/", "TELEMETRY_KEY": "tlm_x"})
        self.assertEqual((cfg.gateway, cfg.container, cfg.iface, cfg.top_domains), ("https://gw.example", "trojan", "eth0", 50))
        self.assertEqual((cfg.sni, cfg.probe_host, cfg.probe_port, cfg.probe_target, cfg.probe_timeout),
                         ("trojan.xianliao.de5.net", "trojan.xianliao.de5.net", 443, "www.gstatic.com:80", 15.0))
        custom = agent.Config({"TELEMETRY_GATEWAY": "https://g", "TELEMETRY_KEY": "k", "TOP_DOMAINS": "5", "PROBE_HOST": "10.0.0.1", "TROJAN_SNI": "x.example"})
        self.assertEqual((custom.top_domains, custom.probe_host, custom.sni), (5, "10.0.0.1", "x.example"))

    def test_missing_or_malformed_values_are_configuration_errors(self):
        for env in [{}, {"TELEMETRY_GATEWAY": "g"}, {"TELEMETRY_KEY": "k"},
                    {"TELEMETRY_GATEWAY": "https://g", "TELEMETRY_KEY": "k", "TOP_DOMAINS": "0"},
                    {"TELEMETRY_GATEWAY": "https://g", "TELEMETRY_KEY": "k", "PROBE_TIMEOUT": "x"},
                    {"TELEMETRY_GATEWAY": "https://g", "TELEMETRY_KEY": "k", "PROBE_TARGET": "nohostport"}]:
            with self.assertRaises(agent.ConfigError):
                agent.Config(env)

    def test_the_env_file_is_parsed_with_quotes_and_never_overrides_the_environment(self):
        path = os.path.join(tempfile.mkdtemp(), "agent.env")
        with open(path, "w") as handle:
            handle.write("# comment\nTELEMETRY_GATEWAY='https://gw.example'\nTELEMETRY_KEY='it'\\''s'\nTROJAN_CONTAINER=plain\nbad line\nlower=1\n")
        env = {"TROJAN_CONTAINER": "from-env"}
        agent.load_env_file(path, env)
        self.assertEqual(env, {"TELEMETRY_GATEWAY": "https://gw.example", "TELEMETRY_KEY": "it's", "TROJAN_CONTAINER": "from-env"})
        agent.load_env_file(os.path.join(path, "missing"), env)


class TimeTest(unittest.TestCase):
    def test_hour_helpers_round_trip(self):
        epoch = agent.parse_iso("2026-11-16T13:00:00Z")
        self.assertEqual(agent.iso_hour(epoch), "2026-11-16T13:00:00Z")
        self.assertEqual(agent.hour_label(epoch), "2026-11-16T13")
        self.assertEqual(agent.parse_hour_label("2026-11-16T13"), epoch)
        self.assertEqual(agent.floor_hour(epoch + 1799), epoch)


if __name__ == "__main__":
    unittest.main()


NGINX = ('nginx_stream_conn t=2026-11-23T08:12:44+00:00 ms=1795421564.583 ip=104.28.1.2 port=43223 sni="trojan.xianliao.de5.net" '
         'up=127.0.0.1:8443 sent=9715 recv=984 dur=1.058 st=200')
TROJAN_NATIVE = ("[INFO]  2026/11/22 12:01:11 user %s from 127.0.0.1:43454 tunneling to rr4---sn-xx.googlevideo.com:443 closed "
                 "sent: 793.71 KiB recv: 21.69 KiB" % HASH_A)


class NginxLineTest(unittest.TestCase):
    def test_an_ipv4_line_is_parsed(self):
        record = agent.parse_conn_line(NGINX)
        self.assertEqual(record, {"ms": 1795421564.583, "ip": "104.28.1.2", "port": 43223, "sni": "trojan.xianliao.de5.net",
                                  "sent": 9715, "recv": 984, "dur": 1.058, "status": 200})

    def test_an_ipv6_line_and_a_docker_timestamp_prefix_are_parsed(self):
        text = "2026-11-23T08:12:44.583000000Z " + NGINX.replace("ip=104.28.1.2", "ip=2606:4700:4700::1111")
        self.assertEqual(agent.parse_conn_line(text)["ip"], "2606:4700:4700::1111")

    def test_a_v4_mapped_address_is_unwrapped(self):
        self.assertEqual(agent.parse_conn_line(NGINX.replace("ip=104.28.1.2", "ip=::ffff:1.2.3.4"))["ip"], "1.2.3.4")

    def test_a_missing_or_empty_sni_is_an_empty_string_and_the_sni_is_lowercased(self):
        self.assertEqual(agent.parse_conn_line(NGINX.replace('sni="trojan.xianliao.de5.net"', 'sni=""'))["sni"], "")
        self.assertEqual(agent.parse_conn_line(NGINX.replace('sni="trojan.xianliao.de5.net"', 'sni="-"'))["sni"], "")
        self.assertEqual(agent.parse_conn_line(NGINX.replace("trojan.xianliao", "TROJAN.xianliao"))["sni"], "trojan.xianliao.de5.net")

    def test_garbage_is_not_a_record(self):
        self.assertIsNone(agent.parse_conn_line("nothing here"))
        self.assertIsNone(agent.parse_conn_line(NGINX.replace("ip=104.28.1.2", "ip=not-an-ip")))
        self.assertIsNone(agent.parse_conn_line(NGINX.replace("sent=9715", "sent=-1")))


class LineTimeTest(unittest.TestCase):
    def test_a_docker_prefix_is_precise_utc(self):
        when, tolerance = agent.parse_line_time("2026-11-22T12:01:11.250000000Z " + TROJAN_NATIVE)
        self.assertAlmostEqual(when, agent.parse_iso("2026-11-22T12:01:11Z") + 0.25)
        self.assertEqual(tolerance, 2.0)

    def test_the_lines_own_second_timestamps_are_centred_with_a_wider_tolerance(self):
        for text in (TROJAN_NATIVE, line(HASH_A, "a.com:80", "1 B", "1 B", "2026-11-22T12:01:11Z")):
            when, tolerance = agent.parse_line_time(text)
            self.assertEqual(when, agent.parse_iso("2026-11-22T12:01:11Z") + 0.5)
            self.assertEqual(tolerance, 2.5)

    def test_no_timestamp_is_none(self):
        self.assertIsNone(agent.parse_line_time("user abc tunneling to a.com:80 closed sent: 1 B recv: 1 B"))


class NetworkTest(unittest.TestCase):
    def test_websites_keep_only_the_network(self):
        self.assertEqual(agent.client_network("203.0.113.77"), "203.0.113.0/24")
        self.assertEqual(agent.client_network("2001:db8:1:2:3:4:5:6"), "2001:db8:1::/48")


ROUTES = {"dental.example": ("dentalrendering", "dental"), "museum.example": ("museum", "museum")}


class ScanTest(unittest.TestCase):
    def scan(self, lines, sni="trojan.xianliao.de5.net"):
        scan = agent.LogScan(USERS, ROUTES, sni)
        for raw in lines:
            scan.add_line(raw)
        return scan

    def test_trojan_tunnels_and_nginx_connections_are_collected_next_to_the_totals(self):
        scan = self.scan(["2026-11-22T12:01:11.250000000Z " + TROJAN_NATIVE, NGINX])
        self.assertEqual(scan.totals[("#1", "googlevideo.com")], [int(round(793.71 * 1024)), int(round(21.69 * 1024)), 1])
        self.assertEqual(scan.tunnels, [(agent.parse_iso("2026-11-22T12:01:11Z") + 0.25, 2.0, int(round(793.71 * 1024)), int(round(21.69 * 1024)), "#1", "googlevideo.com", 5)])
        self.assertEqual(scan.conns, [(1795421564.583, "104.28.1.2", 9715, 984)])

    def test_website_connections_aggregate_per_site_and_network(self):
        sites = [NGINX.replace("trojan.xianliao.de5.net", "dental.example").replace("104.28.1.2", "198.51.100.%d" % n) for n in (5, 77)]
        sites.append(NGINX.replace("trojan.xianliao.de5.net", "museum.example"))
        scan = self.scan(sites)
        self.assertEqual(scan.sites[("dentalrendering", "dental", "198.51.100.0/24")], [2 * 9715, 2 * 984, 2, "198.51.100.5"])
        self.assertEqual(scan.sites[("museum", "museum", "104.28.1.0/24")], [9715, 984, 1, "104.28.1.2"])
        self.assertEqual(scan.conns, [])

    def test_other_snis_are_ignored(self):
        scan = self.scan([NGINX.replace("trojan.xianliao.de5.net", "other.example"), NGINX.replace('sni="trojan.xianliao.de5.net"', 'sni=""')])
        self.assertEqual((scan.conns, scan.sites), ([], {}))

    def test_merging_two_scans_adds_everything(self):
        first = self.scan([NGINX, line(HASH_A, "a.com:80", "1.00 KiB", "1.00 KiB")])
        second = self.scan([NGINX, line(HASH_A, "a.com:80", "1.00 KiB", "1.00 KiB"), NGINX.replace("trojan.xianliao.de5.net", "dental.example")])
        first.merge(second)
        self.assertEqual(len(first.conns), 2)
        self.assertEqual(first.totals[("#1", "a.com")], [2048, 2048, 2])
        self.assertEqual(len(first.tunnels), 2)
        self.assertEqual(first.sites[("dentalrendering", "dental", "104.28.1.0/24")][2], 1)

    def test_the_default_record_cap_is_200k(self):
        self.assertEqual(agent.MAX_RECORDS, 200000)

    def test_the_record_caps_drop_the_excess_and_say_so(self):
        scan = agent.LogScan(USERS, ROUTES, "trojan.xianliao.de5.net", limit=2)
        for _ in range(5):
            scan.add_line(NGINX)
        self.assertEqual((len(scan.conns), scan.dropped), (2, 3))
