import os
import shutil
import tempfile
import unittest

from geo_fixtures import build_mmdb
from support import load_agent

agent = load_agent()

CITY_A = {"city": {"names": {"en": "Ashburn", "de": "Ashburn"}}, "country": {"iso_code": "US", "names": {"en": "United States"}},
          "subdivisions": [{"names": {"en": "Virginia"}}], "location": {"latitude": 39.0437, "longitude": -77.4875}}
CITY_B = {"city": {"names": {"en": "Tokyo"}}, "country": {"iso_code": "JP", "names": {"en": "Japan"}}, "subdivisions": []}
NETWORKS = [("1.2.3.0/24", CITY_A), ("8.8.0.0/16", CITY_B), ("2001:db8::/32", CITY_B), ("2a00:1450::/29", CITY_A)]


class MmdbTest(unittest.TestCase):
    def test_every_record_size_and_pointer_mode_resolves_the_same_records(self):
        for record_size in (24, 28, 32):
            for pointers in (True, False):
                db = agent.Mmdb(build_mmdb(NETWORKS, record_size=record_size, pointers=pointers))
                label = (record_size, pointers)
                self.assertEqual(db.get("1.2.3.77"), CITY_A, label)
                self.assertEqual(db.get("8.8.200.1"), CITY_B, label)
                self.assertEqual(db.get("2001:db8:1::5"), CITY_B, label)
                self.assertEqual(db.get("2a00:1450:4001::1"), CITY_A, label)

    def test_addresses_outside_every_network_are_not_found(self):
        db = agent.Mmdb(build_mmdb(NETWORKS))
        for ip in ("1.2.4.1", "9.9.9.9", "2001:db9::1", "::1", "nope", ""):
            self.assertIsNone(db.get(ip), ip)

    def test_an_ipv4_only_tree_answers_ipv4_and_not_ipv6(self):
        db = agent.Mmdb(build_mmdb([("1.2.3.0/24", CITY_A)], ip_version=4))
        self.assertEqual(db.get("1.2.3.4"), CITY_A)
        self.assertIsNone(db.get("2001:db8::1"))

    def test_a_v4_mapped_ipv6_text_is_the_ipv4_address(self):
        db = agent.Mmdb(build_mmdb(NETWORKS))
        self.assertEqual(db.get("::ffff:1.2.3.4"), CITY_A)

    def test_scalar_types_decode(self):
        record = {"asn": 13335, "zero": 0, "big": 4200000000, "huge": 2 ** 40, "pi": 3.5, "yes": True, "no": False,
                  "long": "x" * 300, "longer": "y" * 70000, "list": [1, "a", {"k": "v"}], "empty": {}, "text": "中文"}
        db = agent.Mmdb(build_mmdb([("10.0.0.0/8", record)]))
        self.assertEqual(db.get("10.1.1.1"), record)

    def test_pointers_inside_nested_maps_resolve(self):
        records = [("1.0.0.0/8", {"a": {"names": {"en": "same"}}, "b": {"names": {"en": "same"}}}), ("2.0.0.0/8", {"c": {"names": {"en": "same"}}})]
        db = agent.Mmdb(build_mmdb(records))
        self.assertEqual(db.get("2.2.2.2"), {"c": {"names": {"en": "same"}}})
        self.assertEqual(db.get("1.2.2.2")["b"]["names"]["en"], "same")

    def test_the_metadata_is_exposed(self):
        db = agent.Mmdb(build_mmdb(NETWORKS))
        self.assertEqual((db.metadata["ip_version"], db.metadata["record_size"]), (6, 24))

    def test_garbage_is_refused(self):
        for data in (b"", b"x" * 100, build_mmdb(NETWORKS)[:-30]):
            with self.assertRaises(ValueError):
                agent.Mmdb(data)

    def test_a_pointer_loop_raises_instead_of_hanging(self):
        data = bytearray(build_mmdb([("1.0.0.0/8", {"a": "b"})], pointers=False))
        start = agent.Mmdb(bytes(data)).data_start
        data[start:start + 2] = b"\x20\x00"  # the record at offset 0 is a pointer to offset 0
        with self.assertRaises(ValueError):
            agent.Mmdb(bytes(data)).get("1.2.3.4")

    def test_a_lookup_that_would_decode_too_many_nodes_is_refused(self):
        record = {"list": list(range(5000))}
        db = agent.Mmdb(build_mmdb([("10.0.0.0/8", record)]))
        db.NODE_BUDGET = 1000
        with self.assertRaises(ValueError):
            db.get("10.1.1.1")
        db.NODE_BUDGET = 100000
        self.assertEqual(db.get("10.1.1.1"), record)

    def test_open_reads_a_file_and_geo_uses_city_and_asn_files(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        path = os.path.join(tmp, "city.mmdb")
        with open(path, "wb") as handle:
            handle.write(build_mmdb(NETWORKS))
        db = agent.Mmdb.open(path)
        self.addCleanup(db.close)
        asn = agent.Mmdb(build_mmdb([("1.2.3.0/24", {"autonomous_system_number": 16509, "autonomous_system_organization": "Amazon.com, Inc."}),
                                     ("104.28.0.0/16", {"autonomous_system_number": 13335, "autonomous_system_organization": "Cloudflare, Inc."})]))
        geo = agent.Geo(None, db, asn)
        self.assertEqual(geo.location("1.2.3.4"), "US, Ashburn · Amazon")
        self.assertEqual(geo.location("104.28.1.2"), "Cloudflare")
        self.assertEqual(geo.location("8.8.8.8"), "JP, Tokyo")
