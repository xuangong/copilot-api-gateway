import json
import os
import unittest

from support import load_agent

agent = load_agent()

T0 = 1795421564.0


def tunnel(when, sent, recv=100, tol=2.0, user="#1", domain="x.com", slack=0):
    return (when, tol, sent, recv, user, domain, slack)


def conn(when, ip, sent, recv=100):
    return (when, ip, sent, recv)


class CorrelateTest(unittest.TestCase):
    def match(self, tunnels, conns):
        return agent.correlate(tunnels, conns)

    def test_an_exact_match_attributes_the_client(self):
        ips, matched = self.match([tunnel(T0, 5000)], [conn(T0 + 0.3, "1.1.1.1", 5000)])
        self.assertEqual((ips, matched), (["1.1.1.1"], 1))

    def test_nginx_counts_tls_overhead_so_its_sent_may_exceed_the_payload_by_15_percent_or_8_kib(self):
        big = 10 * 1024 * 1024
        cases = [(big, int(big * 1.15), True), (big, int(big * 1.16), False), (1000, 1000 + 8192, True), (1000, 1000 + 8193, False),
                 (big, big - 1, False), (0, 4000, True)]
        for trojan_sent, nginx_sent, expected in cases:
            ips, _ = self.match([tunnel(T0, trojan_sent)], [conn(T0, "1.1.1.1", nginx_sent)])
            self.assertEqual(ips[0] == "1.1.1.1", expected, (trojan_sent, nginx_sent))

    def test_a_rounded_printed_size_may_exceed_the_real_one_by_half_a_percent_of_its_unit(self):
        gib = 1024 ** 3
        printed = int(round(1.5 * gib))  # "1.50 GiB": the real count may be up to 0.005 GiB (about 5.4 MB) lower
        slack = int(0.005 * gib)
        self.assertEqual(self.match([tunnel(T0, printed, slack=slack)], [conn(T0, "a", printed - slack + 10)])[0], ["a"])
        self.assertEqual(self.match([tunnel(T0, printed, slack=slack)], [conn(T0, "a", printed - slack - 10)])[0], [None])
        self.assertEqual(self.match([tunnel(T0, printed)], [conn(T0, "a", printed - 10)])[0], [None])

    def test_the_agent_derives_the_slack_from_the_printed_unit(self):
        scan = agent.LogScan({"ab": "#1"}, {}, "t.example")
        scan.add_line('time="2026-11-16T13:05:12Z" level=info msg="user ab from 1.2.3.4:1 tunneling to a.com:443 closed sent: 1.50 GiB recv: 2.00 KiB"')
        self.assertEqual(scan.tunnels[0][6], int(0.005 * 1024 ** 3))

    def test_the_close_times_must_be_within_the_tunnels_tolerance(self):
        self.assertEqual(self.match([tunnel(T0, 5000)], [conn(T0 + 2.0, "a", 5000)])[0], ["a"])
        self.assertEqual(self.match([tunnel(T0, 5000)], [conn(T0 - 2.0, "a", 5000)])[0], ["a"])
        self.assertEqual(self.match([tunnel(T0, 5000)], [conn(T0 + 2.1, "a", 5000)])[0], [None])
        self.assertEqual(self.match([tunnel(T0 + 0.5, 5000, tol=2.5)], [conn(T0 + 3.0, "a", 5000)])[0], ["a"])

    def test_the_smallest_time_gap_wins_then_the_smallest_relative_byte_difference(self):
        ips, _ = self.match([tunnel(T0, 5000)], [conn(T0 + 1.5, "far", 5000), conn(T0 + 0.2, "near", 5400)])
        self.assertEqual(ips, ["near"])
        ips, _ = self.match([tunnel(T0, 50000)], [conn(T0 + 1.0, "loose", 52000), conn(T0 - 1.0, "tight", 50500)])
        self.assertEqual(ips, ["tight"])

    def test_each_nginx_record_is_used_at_most_once_and_bigger_tunnels_choose_first(self):
        ips, matched = self.match([tunnel(T0, 5000), tunnel(T0 + 0.1, 40000)], [conn(T0, "only", 40500)])
        self.assertEqual((ips, matched), ([None, "only"], 1))
        ips, matched = self.match([tunnel(T0, 5000), tunnel(T0, 5000)], [conn(T0, "a", 5000), conn(T0, "b", 5000)])
        self.assertEqual((sorted(ips), matched), (["a", "b"], 2))

    def test_unmatched_tunnels_stay_in_input_order_and_no_connections_means_no_matches(self):
        self.assertEqual(self.match([tunnel(T0, 1), tunnel(T0, 2)], []), ([None, None], 0))
        self.assertEqual(self.match([], [conn(T0, "a", 1)]), ([], 0))

    def test_the_match_rate_is_per_mille_of_tunnels(self):
        self.assertEqual(agent.match_rate(3, 4), 750)
        self.assertEqual(agent.match_rate(1, 3), 333)
        self.assertEqual(agent.match_rate(0, 5), 0)
        self.assertIsNone(agent.match_rate(0, 0))

    def test_many_records_are_matched_without_a_quadratic_scan(self):
        tunnels = [tunnel(T0 + i * 0.01, 1000 + i) for i in range(3000)]
        conns = [conn(T0 + i * 0.01, "10.0.%d.%d" % (i // 256, i % 256), 1000 + i) for i in range(3000)]
        ips, matched = self.match(tunnels, conns)
        self.assertEqual(matched, 3000)


# ---- end to end: the real agent with fake docker/vnstat output and a fake gateway ----

from geo_fixtures import build_mmdb, build_xdb  # noqa: E402
from test_geo_update import FakeFetcher  # noqa: E402
from test_runner import HASH_A, KEY, RunnerCase, line  # noqa: E402

KEY_DENTAL = "tlm_" + "d" * 64
KEY_MUSEUM = "tlm_" + "e" * 64
SITES = ("dentalrendering=dental.xianliao.de5.net:dental,dental-dev.xianliao.de5.net:dental-dev;museum=museum.xianliao.de5.net:museum")
GEO_FILES = {
    "https://raw.githubusercontent.com/lionsoul2014/ip2region/master/data/ip2region_v4.xdb":
        build_xdb([("1.0.0.0", "1.0.255.255", "中国|0|广东省|深圳市|电信")]),
    "https://download.db-ip.com/free/dbip-city-lite-2026-11.mmdb.gz": build_mmdb([
        ("1.2.3.0/24", {"country": {"iso_code": "US"}, "city": {"names": {"en": "Ashburn"}}}),
        ("2001:db8::/32", {"country": {"iso_code": "JP"}, "city": {"names": {"en": "Tokyo"}}})]),
    "https://download.db-ip.com/free/dbip-asn-lite-2026-11.mmdb.gz": build_mmdb([
        ("1.2.3.0/24", {"autonomous_system_number": 16509, "autonomous_system_organization": "Amazon.com, Inc."}),
        ("104.28.0.0/16", {"autonomous_system_number": 13335, "autonomous_system_organization": "Cloudflare, Inc."})]),
}
H13 = agent.parse_iso("2026-11-16T13:00:00Z")
NOW_EPOCH = agent.parse_iso("2026-11-16T14:05:00Z")


def docker_stamp(offset):
    return time_text(H13 + offset)


def time_text(epoch):
    import time as _time
    whole = int(epoch)
    return _time.strftime("%Y-%m-%dT%H:%M:%S", _time.gmtime(whole)) + ("%.9f" % (epoch - whole))[1:] + "Z"


def trojan(offset, host, sent, recv):
    return "%s %s" % (docker_stamp(offset), line(HASH_A, host + ":443", sent, recv, "2026-11-16T13:00:00Z"))


def nginx(offset, ip, sni, sent, recv):
    return "%s nginx_stream_conn t=x ms=%.3f ip=%s port=1000 sni=\"%s\" up=127.0.0.1:8443 sent=%d recv=%d dur=1.0 st=200" % (
        docker_stamp(offset), H13 + offset, ip, sni, sent, recv)


class EndToEndTest(RunnerCase):
    def setUp(self):
        RunnerCase.setUp(self)
        self.env.update({"TELEMETRY_SITES": SITES, "TELEMETRY_KEY_DENTALRENDERING": KEY_DENTAL, "TELEMETRY_KEY_MUSEUM": KEY_MUSEUM, "GEO_DOWNLOAD": "1"})
        self.set_cursor("2026-11-16T12:00:00Z")
        trojan_sni = "trojan.xianliao.de5.net"
        lines = [
            trojan(605.2, "rr4---sn-xx.googlevideo.com", "500000 B", "20000 B"), nginx(605.4, "1.0.0.5", trojan_sni, 510000, 21000),
            trojan(1200.1, "www.example.org", "3000 B", "100 B"), nginx(1200.3, "1.2.3.4", trojan_sni, 6000, 900),
            trojan(1800.0, "a.com", "1000 B", "1000 B"), nginx(1800.2, "104.28.1.2", trojan_sni, 1500, 1300),
            trojan(2400.0, "b.com", "10 B", "10 B"),
            nginx(100.0, "1.0.0.5", "dental.xianliao.de5.net", 1000, 100), nginx(200.0, "1.0.0.77", "dental.xianliao.de5.net", 2000, 200),
            nginx(300.0, "2001:db8:1:2::9", "dental-dev.xianliao.de5.net", 50, 5),
            nginx(400.0, "9.9.9.9", "museum.xianliao.de5.net", 70, 7),
            nginx(500.0, "9.9.9.9", "other.example", 999, 9),
        ]
        self.runner.logs["2026-11-16T13:00:00Z"] = "\n".join(lines)
        self.fetcher = FakeFetcher(GEO_FILES)

    def pushes(self):
        return dict((r["auth"][len("Bearer "):], r["body"]["points"]) for r in self.server.requests)

    def values(self, points, metric):
        return dict((tuple(sorted(p.get("dims", {}).items())), p["value"]) for p in points if p["metric"] == metric)

    def prefetch(self):
        agent.GeoStore(os.path.join(self.state_dir, "geo"), fetcher=self.fetcher).refresh(NOW_EPOCH)
        self.fetcher.calls.clear()

    def test_the_refresh_runs_after_the_push_so_it_never_delays_the_hour(self):
        events = []
        real = self.fetcher.__call__
        self.fetcher = FakeFetcher(GEO_FILES)
        original_call = FakeFetcher.__call__

        def spy(url, destination, max_bytes, gunzip, timeout=30, deadline=900):
            events.append(("fetch", len(self.server.requests)))
            return original_call(self.fetcher, url, destination, max_bytes, gunzip, timeout, deadline)

        code, _ = self.run_main(geo_fetcher=spy)
        self.assertEqual(code, 0)
        self.assertEqual(set(n for _, n in events), {3})  # all three pushes were done before the first download
        self.assertTrue(os.path.exists(os.path.join(self.state_dir, "geo", "ip2region.xdb")))

    def test_three_sources_receive_their_own_client_points(self):
        self.prefetch()
        code, _ = self.run_main(geo_fetcher=self.fetcher)
        self.assertEqual(code, 0)
        pushes = self.pushes()
        self.assertEqual(sorted(pushes), sorted([KEY, KEY_DENTAL, KEY_MUSEUM]))
        trojan_points = pushes[KEY]

        def dims(client, location, domain):
            return tuple(sorted({"client": client, "location": location, "domain": domain}.items()))

        sent = self.values(trojan_points, "proxy.client_bytes")
        self.assertEqual(sent, {
            dims("1.0.0.5", "广东省 深圳市 · 电信", "googlevideo.com"): 520000,
            dims("1.2.3.4", "US, Ashburn · Amazon", "example.org"): 3100,
            dims("104.28.1.2", "Cloudflare", "a.com"): 2000,
            dims("(unmatched)", "未知", "b.com"): 20,
        })
        self.assertEqual(self.values(trojan_points, "proxy.client_connections")[dims("1.0.0.5", "广东省 深圳市 · 电信", "googlevideo.com")], 1)
        self.assertEqual(self.values(trojan_points, "proxy.client_match_rate"), {(): 750})
        self.assertTrue(any(p["metric"] == "proxy.sent_bytes" for p in trojan_points))  # existing metrics unchanged

        def site(name, client, location):
            return tuple(sorted({"site": name, "client": client, "location": location}.items()))

        dental = pushes[KEY_DENTAL]
        self.assertEqual(self.values(dental, "site.sent_bytes"), {site("dental", "1.0.0.0/24", "广东省 深圳市 · 电信"): 3000,
                                                                   site("dental-dev", "2001:db8:1::/48", "JP, Tokyo"): 50})
        self.assertEqual(self.values(dental, "site.recv_bytes")[site("dental", "1.0.0.0/24", "广东省 深圳市 · 电信")], 300)
        self.assertEqual(self.values(dental, "site.connections")[site("dental", "1.0.0.0/24", "广东省 深圳市 · 电信")], 2)
        self.assertEqual(self.values(pushes[KEY_MUSEUM], "site.sent_bytes"), {site("museum", "9.9.9.0/24", "未知"): 70})
        for points in (dental, pushes[KEY_MUSEUM]):
            self.assertEqual(set(p["metric"] for p in points), {"site.sent_bytes", "site.recv_bytes", "site.connections"})
            self.assertTrue(all("1.0.0.5" not in json.dumps(p) and "9.9.9.9" not in json.dumps(p) for p in points))  # websites keep networks only
        self.assertTrue(all(p["unit"] in ("bytes", "count") for p in trojan_points + dental))

    def test_nothing_is_downloaded_when_downloads_are_off_and_locations_are_unknown(self):
        self.env["GEO_DOWNLOAD"] = "0"
        code, _ = self.run_main(geo_fetcher=self.fetcher)
        self.assertEqual((code, self.fetcher.calls), (0, []))
        values = self.values(self.pushes()[KEY], "proxy.client_bytes")
        self.assertEqual(set(dict(k)["location"] for k in values), {"未知"})

    def test_a_failing_geo_download_never_stops_the_telemetry(self):
        code, _ = self.run_main(geo_fetcher=FakeFetcher({}))
        self.assertEqual(code, 0)
        self.assertEqual(len(self.server.requests), 3)

    def test_the_top_n_folds_the_rest_into_other_and_keeps_unmatched(self):
        self.env.update({"TOP_CLIENTS": "1", "TOP_CLIENT_DOMAINS": "1", "GEO_DOWNLOAD": "0"})
        self.run_main()
        values = self.values(self.pushes()[KEY], "proxy.client_bytes")
        clients = sorted(dict(k)["client"] for k in values)
        self.assertEqual(clients, ["(other)", "(unmatched)", "1.0.0.5"])
        self.assertEqual(sum(values.values()), 520000 + 3100 + 2000 + 20)
        self.assertEqual(values[tuple(sorted({"client": "(other)", "location": "(other)", "domain": "(other)"}.items()))], 5100)

    def test_site_clients_fold_too(self):
        self.env.update({"TOP_CLIENTS": "1", "GEO_DOWNLOAD": "0"})
        self.runner.logs["2026-11-16T13:00:00Z"] += "\n" + nginx(600.0, "5.6.7.8", "dental.xianliao.de5.net", 10, 1)
        self.run_main()
        values = self.values(self.pushes()[KEY_DENTAL], "site.sent_bytes")
        by_client = dict((dict(k)["site"] + "|" + dict(k)["client"], v) for k, v in values.items())
        self.assertEqual(by_client, {"dental|1.0.0.0/24": 3000, "dental|(other)": 10, "dental-dev|2001:db8:1::/48": 50})

    def test_the_hour_fits_the_push_limits_however_many_clients_there_are(self):
        self.env.update({"TOP_CLIENTS": "1000", "TOP_CLIENT_DOMAINS": "1000", "GEO_DOWNLOAD": "0"})
        lines = []
        for n in range(4000):
            ip = "10.%d.%d.%d" % (n // 65536, (n // 256) % 256, n % 256)
            lines += [trojan(10 + n * 0.5, "h%d.example%d.com" % (n, n), "1000 B", "10 B"), nginx(10 + n * 0.5, ip, "trojan.xianliao.de5.net", 1000, 10)]
        self.runner.logs["2026-11-16T13:00:00Z"] = "\n".join(lines)
        self.set_cursor("2026-11-16T12:00:00Z")
        self.run_main()
        points = self.pushes()[KEY]
        self.assertLessEqual(len(points), agent.MAX_BATCH_POINTS)
        self.assertLessEqual(agent.points_size(points), agent.MAX_BATCH_BYTES)
        self.assertEqual(sum(p["value"] for p in points if p["metric"] == "proxy.client_bytes"), 4000 * 1000 + 4000 * 10)


class NoNetworkTest(unittest.TestCase):
    def test_the_test_agent_refuses_real_downloads(self):
        with self.assertRaises(IOError):
            agent.download_file("https://download.db-ip.com/free/x.gz", "/nonexistent/x", 10, True)
