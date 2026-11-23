import os
import shutil
import tempfile
import unittest

from geo_fixtures import build_xdb
from support import load_agent

agent = load_agent()

SEGMENTS = [
    ("1.0.0.0", "1.0.255.255", "中国|0|广东省|深圳市|电信"),
    ("1.1.0.0", "1.1.0.255", "美国|0|0|0|Amazon"),
    ("2.0.255.0", "2.1.0.255", "中国|0|北京|北京|联通"),
    ("100.64.0.0", "100.127.255.255", "0|0|0|内网IP|内网IP"),
    ("255.255.255.0", "255.255.255.255", "中国|广东省|广州市|移动"),
]


class Ip2RegionTest(unittest.TestCase):
    def setUp(self):
        self.db = agent.Ip2Region(build_xdb(SEGMENTS))

    def test_addresses_inside_segments_resolve_to_their_region_string(self):
        self.assertEqual(self.db.search("1.0.0.0"), "中国|0|广东省|深圳市|电信")
        self.assertEqual(self.db.search("1.0.77.5"), "中国|0|广东省|深圳市|电信")
        self.assertEqual(self.db.search("1.0.255.255"), "中国|0|广东省|深圳市|电信")
        self.assertEqual(self.db.search("1.1.0.200"), "美国|0|0|0|Amazon")
        self.assertEqual(self.db.search("255.255.255.255"), "中国|广东省|广州市|移动")

    def test_a_segment_that_crosses_a_slash_16_boundary_resolves_on_both_sides(self):
        self.assertEqual(self.db.search("2.0.255.9"), "中国|0|北京|北京|联通")
        self.assertEqual(self.db.search("2.1.0.9"), "中国|0|北京|北京|联通")

    def test_gaps_are_not_found(self):
        for ip in ("0.0.0.1", "1.1.1.0", "2.1.1.0", "2.0.254.255", "9.9.9.9", "255.255.254.1"):
            self.assertIsNone(self.db.search(ip), ip)

    def test_ipv6_and_garbage_are_not_found(self):
        self.assertIsNone(self.db.search("2001:db8::1"))
        self.assertIsNone(self.db.search("nope"))
        self.assertIsNone(self.db.search(""))

    def test_the_parsed_region_feeds_the_location_text(self):
        geo = agent.Geo(self.db, None, None)
        self.assertEqual(geo.location("1.0.0.9"), "广东省 深圳市 · 电信")
        self.assertEqual(geo.location("255.255.255.9"), "广东省 广州市 · 移动")

    def test_a_truncated_or_ipv6_file_is_refused(self):
        data = build_xdb(SEGMENTS)
        with self.assertRaises(ValueError):
            agent.Ip2Region(data[:1000])
        with self.assertRaises(ValueError):
            agent.Ip2Region(b"")
        with self.assertRaises(ValueError):
            agent.Ip2Region(build_xdb(SEGMENTS, ip_version=6))
        with self.assertRaises(ValueError):  # header points past the end
            agent.Ip2Region(data[:-20])

    def test_open_reads_a_file(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        path = os.path.join(tmp, "ip2region.xdb")
        with open(path, "wb") as handle:
            handle.write(build_xdb(SEGMENTS))
        db = agent.Ip2Region.open(path)
        self.assertEqual(db.search("1.1.0.1"), "美国|0|0|0|Amazon")
        db.close()
