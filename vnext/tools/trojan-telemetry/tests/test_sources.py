import json
import os
import unittest

from support import load_agent
from test_runner import HASH_A, KEY, NOW, RunnerCase, line

agent = load_agent()

KEY_DENTAL = "tlm_" + "d" * 64
KEY_MUSEUM = "tlm_" + "e" * 64
SITES = ("dentalrendering=dental.xianliao.de5.net:dental,dental-minio.xianliao.de5.net:dental-minio,dental-dev.xianliao.de5.net:dental-dev;"
         "museum=museum.xianliao.de5.net:museum")


def config(**extra):
    env = {"TELEMETRY_GATEWAY": "https://gw.example", "TELEMETRY_KEY": KEY}
    env.update(extra)
    return agent.Config(env)


class SourceConfigTest(unittest.TestCase):
    def test_without_sites_there_is_only_the_trojan_source(self):
        cfg = config()
        self.assertEqual([t.name for t in cfg.targets], ["trojan-vm"])
        self.assertEqual((cfg.targets[0].key, cfg.targets[0].outbox_name, cfg.routes), (KEY, "outbox", {}))

    def test_sites_define_sources_routes_and_per_source_keys(self):
        cfg = config(TELEMETRY_SITES=SITES, TELEMETRY_KEY_DENTALRENDERING=KEY_DENTAL, TELEMETRY_KEY_MUSEUM=KEY_MUSEUM)
        self.assertEqual([(t.name, t.key, t.outbox_name) for t in cfg.targets],
                         [("trojan-vm", KEY, "outbox"), ("dentalrendering", KEY_DENTAL, "outbox-dentalrendering"), ("museum", KEY_MUSEUM, "outbox-museum")])
        self.assertEqual(cfg.routes["dental-dev.xianliao.de5.net"], ("dentalrendering", "dental-dev"))
        self.assertEqual(cfg.routes["museum.xianliao.de5.net"], ("museum", "museum"))
        self.assertTrue(all(t.gateway == "https://gw.example" for t in cfg.targets))

    def test_a_source_name_with_a_dash_reads_its_key_with_an_underscore(self):
        cfg = config(TELEMETRY_SITES="my-site=a.example:a", TELEMETRY_KEY_MY_SITE=KEY_DENTAL)
        self.assertEqual(cfg.targets[1].key, KEY_DENTAL)

    def test_a_source_without_a_key_is_skipped_and_its_sni_is_not_routed(self):
        cfg = config(TELEMETRY_SITES=SITES, TELEMETRY_KEY_MUSEUM=KEY_MUSEUM)
        self.assertEqual([t.name for t in cfg.targets], ["trojan-vm", "museum"])
        self.assertNotIn("dental.xianliao.de5.net", cfg.routes)
        self.assertEqual(cfg.skipped_sources, ["dentalrendering"])

    def test_malformed_sites_are_a_configuration_error(self):
        for value in ("museum", "museum=", "museum=host", "museum=host:", "Bad Name=a.example:a", "m=a.example:a b", "m=a.example:a;m=b.example:b",
                      "m=a.example:a;n=a.example:b", "m=trojan.xianliao.de5.net:t", "m=:a", "m=a_b.example:a"):
            with self.assertRaises(agent.ConfigError, msg=value):
                config(TELEMETRY_SITES=value, TELEMETRY_KEY_M=KEY_DENTAL, TELEMETRY_KEY_N=KEY_DENTAL)

    def test_snis_are_case_insensitive_and_whitespace_is_trimmed(self):
        cfg = config(TELEMETRY_SITES=" m = A.Example : a , B.example:b ; ", TELEMETRY_KEY_M=KEY_DENTAL)
        self.assertEqual(sorted(cfg.routes), ["a.example", "b.example"])

    def test_top_clients_geo_and_limits_have_defaults_and_validate(self):
        cfg = config()
        self.assertEqual((cfg.top_clients, cfg.top_client_domains, cfg.geo_download), (50, 20, True))
        cfg = config(TOP_CLIENTS="5", TOP_CLIENT_DOMAINS="3", GEO_DOWNLOAD="0")
        self.assertEqual((cfg.top_clients, cfg.top_client_domains, cfg.geo_download), (5, 3, False))
        with self.assertRaises(agent.ConfigError):
            config(TOP_CLIENTS="0")


class SourceStateTest(RunnerCase):
    def test_each_source_has_its_own_outbox_and_all_share_one_cursor(self):
        cfg = config(TELEMETRY_SITES=SITES, TELEMETRY_KEY_DENTALRENDERING=KEY_DENTAL)
        primary = agent.State(self.state_dir)
        other = primary.for_target(cfg.targets[1])
        primary.ensure()
        other.ensure()
        self.assertEqual(sorted(os.listdir(self.state_dir)), ["outbox", "outbox-dentalrendering"])
        self.assertEqual(other.cursor_path, primary.cursor_path)
        other.write_outbox(agent.parse_iso("2026-11-16T10:00:00Z"), [], False)
        self.assertEqual(primary.list_outbox(), [])
        self.assertEqual([name for _, name in other.list_outbox()], ["2026-11-16T10.json"])

    def test_stale_temporaries_are_removed_from_every_outbox(self):
        primary = agent.State(self.state_dir)
        other = primary.for_target(config(TELEMETRY_SITES=SITES, TELEMETRY_KEY_MUSEUM=KEY_MUSEUM).targets[1])
        primary.ensure()
        other.ensure()
        stale = os.path.join(other.outbox, "2026-01-01T00.json.tmp")
        with open(stale, "w") as handle:
            handle.write("{")
        primary.clean_temporaries()
        self.assertFalse(os.path.exists(stale))


class MultiSourceRunTest(RunnerCase):
    def setUp(self):
        RunnerCase.setUp(self)
        self.env.update({"TELEMETRY_SITES": SITES, "TELEMETRY_KEY_DENTALRENDERING": KEY_DENTAL, "TELEMETRY_KEY_MUSEUM": KEY_MUSEUM,
                         "GEO_DOWNLOAD": "0"})
        self.set_cursor("2026-11-16T12:00:00Z")

    def outbox_of(self, suffix):
        path = os.path.join(self.state_dir, "outbox" + suffix)
        return sorted(os.listdir(path)) if os.path.isdir(path) else None

    def test_every_source_is_pushed_with_its_own_key(self):
        code, _ = self.run_main()
        self.assertEqual(code, 0)
        keys = [r["auth"] for r in self.server.requests]
        self.assertEqual(sorted(keys), sorted(["Bearer " + KEY, "Bearer " + KEY_DENTAL, "Bearer " + KEY_MUSEUM]))
        self.assertEqual(self.cursor(), "2026-11-16T13:00:00Z")
        self.assertEqual([self.outbox_of(s) for s in ("", "-dentalrendering", "-museum")], [[], [], []])

    def test_the_cursor_is_shared_so_the_hour_is_read_once_for_all_sources(self):
        self.run_main()
        self.assertEqual(self.runner.since(), ["2026-11-16T13:00:00Z"])

    def test_proxy_points_belong_to_the_trojan_source_only(self):
        self.env["TROJAN_USERS"] = HASH_A
        self.runner.logs["2026-11-16T13:00:00Z"] = line(HASH_A, "a.com:80", "1 KiB", "1 KiB", "2026-11-16T13:10:00Z")
        self.run_main()
        by_key = dict((r["auth"], r["body"]["points"]) for r in self.server.requests)
        self.assertTrue(any(p["metric"].startswith("proxy.") for p in by_key["Bearer " + KEY]))
        self.assertFalse(any(p["metric"].startswith("probe.") or p["metric"].startswith("proxy.") for p in by_key["Bearer " + KEY_DENTAL]))

    def test_one_failing_source_keeps_its_outbox_and_does_not_stop_the_others(self):
        self.server.statuses = [200, 503, 200]  # trojan, dentalrendering, museum
        code, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(self.outbox_of(""), [])
        self.assertEqual(self.outbox_of("-dentalrendering"), ["2026-11-16T13.json"])
        self.assertEqual(self.outbox_of("-museum"), [])
        self.server.statuses = []
        self.server.requests.clear()
        code, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("Bearer " + KEY_DENTAL, [r["auth"] for r in self.server.requests])
        self.assertEqual(self.outbox_of("-dentalrendering"), [])

    def test_a_source_without_a_key_is_not_pushed_and_has_no_outbox(self):
        del self.env["TELEMETRY_KEY_MUSEUM"]
        self.run_main()
        self.assertNotIn("Bearer " + KEY_MUSEUM, [r["auth"] for r in self.server.requests])
        self.assertIsNone(self.outbox_of("-museum"))
