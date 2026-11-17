import json
import re
import unittest

from support import load_agent

agent = load_agent()

METRIC = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$")
DIM_KEY = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
HOUR = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$")
NOW = agent.parse_iso("2026-11-16T14:05:00Z")


def gateway_rejects(raw_body, now):
    """A Python restatement of packages/gateway/src/control-plane/telemetry/protocol.ts parsePushBody plus the body limit.
    Returns a reason string, or None when the gateway would accept the body."""
    if len(raw_body) > 2 * 1024 * 1024:
        return "body too large"
    body = json.loads(raw_body.decode("utf-8"))
    if set(body) - {"version", "points"} or body.get("version") != 1 or not isinstance(body.get("points"), list):
        return "envelope"
    if len(body["points"]) > 20000:
        return "too many points"
    units, hours, seen = {}, set(), set()
    for raw in body["points"]:
        if set(raw) - {"metric", "hour", "dims", "value", "unit"}:
            return "unknown field"
        metric = raw.get("metric")
        if not isinstance(metric, str) or not 1 <= len(metric) <= 64 or not METRIC.match(metric):
            return "metric"
        hour = raw.get("hour")
        if not isinstance(hour, str) or not HOUR.match(hour):
            return "hour"
        dims = raw.get("dims", {})
        if not isinstance(dims, dict) or len(dims) > 3:
            return "dims"
        for key, value in dims.items():
            if not DIM_KEY.match(key) or not isinstance(value, str) or not 1 <= len(value.encode("utf-16-le")) // 2 <= 256:
                return "dim %s" % key
        value = raw.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or value > 1e15:
            return "value"
        if raw.get("unit") not in ("bytes", "count", "ms"):
            return "unit"
        epoch = agent.parse_iso(hour)
        days = 90 if dims else 400
        if epoch > now + 3600 or epoch < now - days * 86400:
            return "hour out of range"
        if units.setdefault(metric, raw["unit"]) != raw["unit"]:
            return "unit changes"
        identity = (metric, hour, json.dumps(dims, sort_keys=True))
        if identity in seen:
            return "duplicate"
        seen.add(identity)
        hours.add(hour)
        if len(units) > 20 or len(hours) > 168:
            return "too many metrics or hours"
    return None


class GatewayRulesTest(unittest.TestCase):
    def hour_entries(self, hour_epoch, users, domains_per_user, domain_length=30, probe=True):
        totals = {}
        for u in range(users):
            for d in range(domains_per_user):
                domain = ("d%d" % d).ljust(domain_length, "x") + ".com"
                totals[("#%d" % (u + 1), domain)] = [1000 + d, 2000 + d, 1 + d]
        points = agent.build_proxy_points(hour_epoch, totals, 1000)
        label = agent.iso_hour(hour_epoch)
        points.append(agent.point("nic.tx_bytes", label, {}, 123456789012, "bytes"))
        points.append(agent.point("nic.rx_bytes", label, {}, 5, "bytes"))
        entries = [(hour_epoch, agent.hour_label(hour_epoch) + ".json", points)]
        if probe:
            entries.append((hour_epoch, agent.hour_label(hour_epoch) + ".probe.json", [agent.point("probe.ok", label, {}, 0, "count"), agent.point("probe.fail", label, {"stage": "tls"}, 1, "count"), agent.point("probe.latency_ms", label, {}, 9, "ms")]))
        return entries

    def test_the_validator_itself_rejects_what_the_gateway_rejects(self):
        def body(**changes):
            point = {"metric": "m", "hour": "2026-11-16T13:00:00Z", "value": 1, "unit": "count"}
            point.update(changes)
            return json.dumps({"version": 1, "points": [point]}).encode()
        self.assertIsNone(gateway_rejects(body(), NOW))
        self.assertIsNotNone(gateway_rejects(body(dims={"k": ""}), NOW))
        self.assertIsNotNone(gateway_rejects(body(dims={"k": "x" * 257}), NOW))
        self.assertIsNotNone(gateway_rejects(body(dims={"a": "1", "b": "1", "c": "1", "d": "1"}), NOW))
        self.assertIsNotNone(gateway_rejects(body(unit="KiB"), NOW))
        self.assertIsNotNone(gateway_rejects(body(metric="Bad"), NOW))

    def test_a_realistic_worst_case_backlog_is_planned_into_bodies_the_gateway_accepts(self):
        entries = []
        # 30 closed hours of heavy traffic (10 users x 1000 domains, halved by the agent to fit one push), with probes.
        for index in range(30):
            entries.extend(self.hour_entries(NOW - (31 - index) * 3600 - NOW % 3600, users=10, domains_per_user=1000))
        batches = agent.plan_batches(entries)
        self.assertGreater(len(batches), 1)
        for batch in batches:
            raw = agent.encode_body(batch["points"])
            self.assertIsNone(gateway_rejects(raw, NOW))
            self.assertLessEqual(len(batch["hours"]), 24)
            self.assertLessEqual(len(batch["points"]), 10000)
            self.assertLessEqual(len(raw), agent.MAX_BATCH_BYTES + 1024)
        self.assertEqual(sum(len(b["hours"]) for b in batches), 30)

    def test_long_domains_are_clamped_when_parsed(self):
        lines = ['time="t" level=info msg="user %s from 1.2.3.4:1 tunneling to %s:443 closed sent: 1 B recv: 2 B"' % (
            "ab" * 28, "l" * 600 + ".com")]
        parsed = agent.parse_log_text(lines, {"ab" * 28: "#1"})
        self.assertEqual([len(domain) for (_, domain) in parsed], [256])

    def test_an_hour_with_long_domain_names_is_thinned_to_fit_the_body_limit(self):
        hour = NOW - NOW % 3600 - 3600
        totals = {}
        for u in range(10):
            for d in range(900):
                totals[("#%d" % (u + 1), ("%04d" % d).ljust(240, "x"))] = [1, 2, 3]
        points = agent.build_proxy_points(hour, totals, 1000)
        raw = agent.encode_body(points)
        self.assertLess(len(points), 27000)
        self.assertLessEqual(len(raw), agent.MAX_BATCH_BYTES + 1024)
        self.assertIsNone(gateway_rejects(raw, NOW))

    def test_a_non_bmp_host_never_exceeds_the_gateways_utf16_limit(self):
        lines = ['time="t" level=info msg="user %s from 1.2.3.4:1 tunneling to %s:443 closed sent: 1 B recv: 2 B"' % ("ab" * 28, "\U0001F600" * 200 + ".com")]
        points = agent.build_proxy_points(NOW - NOW % 3600 - 3600, agent.parse_log_text(lines, {"ab" * 28: "#1"}), 50)
        self.assertIsNone(gateway_rejects(agent.encode_body(points), NOW))
        self.assertIn("(invalid)", [p["dims"]["domain"] for p in points])
        self.assertIsNotNone(gateway_rejects(agent.encode_body([agent.point("m", "2026-11-16T13:00:00Z", {"k": "\U0001F600" * 200}, 1, "count")]), NOW))

    def test_unusual_hostnames_never_produce_an_invalid_dimension(self):
        user_map = {"ab" * 28: "#1"}
        targets = ["[2001:db8::1]:443", "1.2.3.4:80", "a.b:1", "." + ":1", "x" * 400 + ".example.com:443", "例え.jp:443"]
        lines = ['time="t" level=info msg="user %s from 1.2.3.4:1 tunneling to %s closed sent: 1 B recv: 2 B"' % ("ab" * 28, t) for t in targets]
        points = agent.build_proxy_points(NOW - NOW % 3600 - 3600, agent.parse_log_text(lines, user_map), 50)
        self.assertIsNone(gateway_rejects(agent.encode_body(points), NOW))


if __name__ == "__main__":
    unittest.main()
