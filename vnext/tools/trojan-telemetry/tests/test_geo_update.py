import gzip
import io
import os
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from geo_fixtures import build_mmdb, build_xdb
from support import load_agent

agent = load_agent()

NOW = agent.parse_iso("2026-11-23T08:00:00Z")
DAY = 86400
XDB = build_xdb([("1.0.0.0", "1.0.255.255", "中国|0|广东省|深圳市|电信")])
CITY = build_mmdb([("1.2.3.0/24", {"country": {"iso_code": "US"}, "city": {"names": {"en": "Ashburn"}}})])
ASN = build_mmdb([("1.2.3.0/24", {"autonomous_system_number": 16509, "autonomous_system_organization": "Amazon.com, Inc."})])


class FakeFetcher(object):
    """Stands in for the network: serves bytes by URL; a missing URL fails like a 404."""

    def __init__(self, files):
        self.files = files
        self.calls = []
        self.deadlines = []

    def __call__(self, url, destination, max_bytes, gunzip, timeout=30, deadline=900):
        self.calls.append(url)
        self.deadlines.append(deadline)
        if url not in self.files:
            raise IOError("HTTP 404 for " + url)
        data = self.files[url]
        with open(destination, "wb") as handle:
            handle.write(data)


def all_files(month="2026-11"):
    return {
        "https://raw.githubusercontent.com/lionsoul2014/ip2region/master/data/ip2region_v4.xdb": XDB,
        "https://download.db-ip.com/free/dbip-city-lite-%s.mmdb.gz" % month: CITY,
        "https://download.db-ip.com/free/dbip-asn-lite-%s.mmdb.gz" % month: ASN,
    }


class GeoStoreCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.dir = os.path.join(self.tmp, "geo")

    def store(self, files, **kwargs):
        self.fetcher = FakeFetcher(files)
        store = agent.GeoStore(self.dir, fetcher=self.fetcher, **kwargs)
        real_load = store.load

        def load():
            geo = real_load()
            self.addCleanup(geo.close)
            return geo

        store.load = load
        return store


class UrlTest(unittest.TestCase):
    def test_dbip_tries_the_current_month_then_the_previous_one_across_a_year_end(self):
        self.assertEqual(agent.geo_urls("city", NOW), ["https://download.db-ip.com/free/dbip-city-lite-2026-11.mmdb.gz",
                                                       "https://download.db-ip.com/free/dbip-city-lite-2026-10.mmdb.gz"])
        january = agent.parse_iso("2027-01-02T00:00:00Z")
        self.assertEqual(agent.geo_urls("asn", january)[1], "https://download.db-ip.com/free/dbip-asn-lite-2026-12.mmdb.gz")

    def test_the_plain_ip2region_file_is_gone_upstream_so_the_v4_file_is_first(self):
        self.assertEqual(agent.geo_urls("ip2region", NOW)[0], "https://raw.githubusercontent.com/lionsoul2014/ip2region/master/data/ip2region_v4.xdb")

    def test_ip2region_comes_from_the_official_repository_over_https(self):
        urls = agent.geo_urls("ip2region", NOW)
        self.assertTrue(all(u.startswith("https://raw.githubusercontent.com/lionsoul2014/ip2region/") for u in urls))


class RefreshTest(GeoStoreCase):
    def test_the_first_run_downloads_everything_and_the_databases_answer(self):
        store = self.store(all_files())
        store.refresh(NOW)
        self.assertEqual(sorted(os.listdir(self.dir)), sorted(["ip2region.xdb", "dbip-city-lite.mmdb", "dbip-asn-lite.mmdb"]))
        geo = store.load()
        self.assertEqual(geo.location("1.0.0.5"), "广东省 深圳市 · 电信")
        self.assertEqual(geo.location("1.2.3.4"), "US, Ashburn · Amazon")

    def test_the_previous_month_is_used_when_the_current_one_is_not_published_yet(self):
        store = self.store(all_files("2026-10"))
        store.refresh(NOW)
        self.assertIn("https://download.db-ip.com/free/dbip-city-lite-2026-11.mmdb.gz", self.fetcher.calls)
        self.assertTrue(os.path.exists(os.path.join(self.dir, "dbip-city-lite.mmdb")))

    def test_fresh_files_are_not_downloaded_again_and_old_ones_are(self):
        self.store(all_files()).refresh(NOW)
        store = self.store(dict(all_files("2026-11"), **all_files("2026-12")))
        store.refresh(NOW + 34 * DAY)
        self.assertEqual(self.fetcher.calls, [])
        store.refresh(NOW + 36 * DAY)
        self.assertEqual(len(self.fetcher.calls), 3)

    def test_a_failed_refresh_keeps_the_old_files_and_is_not_retried_for_six_hours(self):
        self.store(all_files()).refresh(NOW)
        with open(os.path.join(self.dir, "dbip-city-lite.mmdb"), "rb") as handle:
            before = handle.read()
        store = self.store({})
        later = NOW + 40 * DAY
        store.refresh(later)
        attempts = len(self.fetcher.calls)
        self.assertGreater(attempts, 0)
        with open(os.path.join(self.dir, "dbip-city-lite.mmdb"), "rb") as handle:
            self.assertEqual(handle.read(), before)
        self.assertEqual(store.load().location("1.2.3.4"), "US, Ashburn · Amazon")
        store.refresh(later + 5 * 3600)
        self.assertEqual(len(self.fetcher.calls), attempts)
        store.refresh(later + 7 * 3600)
        self.assertGreater(len(self.fetcher.calls), attempts)
        self.assertFalse([n for n in os.listdir(self.dir) if n.endswith(".download")])

    def test_one_budget_covers_a_whole_refresh_and_each_download_gets_what_is_left(self):
        clock = [0.0]
        store = self.store(all_files(), clock=lambda: clock[0])
        real = store.fetcher

        def slow(url, destination, max_bytes, gunzip, timeout=30, deadline=900):
            clock[0] += 500
            return real(url, destination, max_bytes, gunzip, timeout, deadline)

        store.fetcher = slow
        store.refresh(NOW, budget=900)
        self.assertEqual(self.fetcher.deadlines, [900, 400])  # the third file finds the budget spent
        self.assertEqual(len(self.fetcher.calls), 2)
        self.assertEqual(sorted(os.listdir(self.dir)), ["dbip-city-lite.mmdb", "ip2region.xdb"])

    def test_a_corrupt_local_file_is_replaced_after_the_retry_window_not_after_35_days(self):
        self.store(all_files()).refresh(NOW)
        with open(os.path.join(self.dir, "dbip-city-lite.mmdb"), "wb") as handle:
            handle.write(b"garbage")
        store = self.store(all_files())
        store.refresh(NOW + DAY)
        self.assertEqual(len(self.fetcher.calls), 1)
        self.assertEqual(store.load().location("1.2.3.4"), "US, Ashburn · Amazon")

    def test_load_survives_any_reader_error(self):
        self.store(all_files()).refresh(NOW)
        store = self.store({}, download=False)
        original = agent.GEO_FILES
        class Boom(object):
            @staticmethod
            def open(path):
                raise RuntimeError("boom")
        agent.GEO_FILES = tuple((k, n, c, g, Boom) for k, n, c, g, r in original)
        try:
            self.assertEqual(store.load().location("1.2.3.4"), "未知")
        finally:
            agent.GEO_FILES = original

    def test_a_download_that_is_not_a_valid_database_is_discarded(self):
        files = all_files()
        files["https://download.db-ip.com/free/dbip-city-lite-2026-11.mmdb.gz"] = b"<html>not a database</html>"
        store = self.store(files)
        store.refresh(NOW)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "dbip-city-lite.mmdb")))
        self.assertTrue(os.path.exists(os.path.join(self.dir, "dbip-asn-lite.mmdb")))
        self.assertEqual(store.load().location("1.0.0.5"), "广东省 深圳市 · 电信")

    def test_without_any_database_locations_are_unknown(self):
        store = self.store({})
        store.refresh(NOW)
        self.assertEqual(store.load().location("1.2.3.4"), "未知")

    def test_download_can_be_switched_off_and_existing_files_still_load(self):
        self.store(all_files()).refresh(NOW)
        store = self.store(all_files(), download=False)
        store.refresh(NOW + 90 * DAY)
        self.assertEqual(self.fetcher.calls, [])
        self.assertEqual(store.load().location("1.2.3.4"), "US, Ashburn · Amazon")

    def test_a_damaged_local_file_is_skipped_with_the_others_still_working(self):
        self.store(all_files()).refresh(NOW)
        with open(os.path.join(self.dir, "dbip-city-lite.mmdb"), "wb") as handle:
            handle.write(b"garbage")
        geo = self.store({}, download=False).load()
        self.assertEqual(geo.location("1.0.0.5"), "广东省 深圳市 · 电信")
        self.assertEqual(geo.location("1.2.3.4"), "未知 · Amazon")


class Handler(BaseHTTPRequestHandler):
    routes = {}

    def do_GET(self):
        body = self.routes.get(self.path)
        if body is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class DownloadFileTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.url = "http://127.0.0.1:%d" % cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.dest = os.path.join(self.tmp, "out")

    def read(self):
        with open(self.dest, "rb") as handle:
            return handle.read()

    def test_a_plain_file_is_saved(self):
        Handler.routes = {"/a": b"hello"}
        agent.download_file(self.url + "/a", self.dest, 1000, False)
        self.assertEqual(self.read(), b"hello")

    def test_gzip_is_decompressed_on_the_fly(self):
        Handler.routes = {"/a.gz": gzip.compress(b"payload" * 100)}
        agent.download_file(self.url + "/a.gz", self.dest, 10000, True)
        self.assertEqual(self.read(), b"payload" * 100)

    def test_the_size_cap_applies_to_the_decompressed_bytes(self):
        Handler.routes = {"/bomb.gz": gzip.compress(b"\0" * 1000000), "/big": b"x" * 5000}
        with self.assertRaises(IOError):
            agent.download_file(self.url + "/bomb.gz", self.dest, 100000, True)
        with self.assertRaises(IOError):
            agent.download_file(self.url + "/big", self.dest, 1000, False)

    def test_an_http_error_raises(self):
        Handler.routes = {}
        with self.assertRaises(IOError):
            agent.download_file(self.url + "/missing", self.dest, 1000, False)

    def test_only_https_or_loopback_urls_are_fetched(self):
        with self.assertRaises(IOError):
            agent.download_file("http://example.invalid/x", self.dest, 1000, False)
        with self.assertRaises(IOError):
            agent.download_file("file:///etc/passwd", self.dest, 1000, False)

    def test_reading_stops_at_the_end_of_the_gzip_stream(self):
        Handler.routes = {"/a.gz": gzip.compress(b"payload") + b"trailing garbage that is never read" * 10}
        agent.download_file(self.url + "/a.gz", self.dest, 10000, True)
        self.assertEqual(self.read(), b"payload")

    def test_a_deadline_stops_a_slow_transfer(self):
        Handler.routes = {"/a": b"hello"}
        with self.assertRaises(IOError):
            agent.download_file(self.url + "/a", self.dest, 1000, False, deadline=-1)
