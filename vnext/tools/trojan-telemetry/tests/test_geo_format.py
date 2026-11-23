import unittest

from support import load_agent

agent = load_agent()


class FakeRegion(object):
    def __init__(self, table):
        self.table = table
        self.calls = 0

    def search(self, ip):
        self.calls += 1
        return self.table.get(ip)


class FakeMmdb(object):
    def __init__(self, table):
        self.table = table

    def get(self, ip):
        return self.table.get(ip)


def city(code, name=None, subdivision=None):
    record = {"country": {"iso_code": code, "names": {"en": code}}}
    if name:
        record["city"] = {"names": {"en": name}}
    if subdivision:
        record["subdivisions"] = [{"names": {"en": subdivision}}]
    return record


def asn(number, org):
    return {"autonomous_system_number": number, "autonomous_system_organization": org}


class RegionParseTest(unittest.TestCase):
    def test_five_fields_country_region_province_city_isp(self):
        self.assertEqual(agent.parse_region("中国|0|广东省|深圳市|电信"), ("中国", "广东省", "深圳市", "电信"))

    def test_four_fields_country_province_city_isp(self):
        self.assertEqual(agent.parse_region("中国|广东省|深圳市|电信"), ("中国", "广东省", "深圳市", "电信"))

    def test_the_current_upstream_layout_ends_with_a_country_code(self):
        self.assertEqual(agent.parse_region("中国|广东省|深圳市|移动|CN"), ("中国", "广东省", "深圳市", "移动"))
        self.assertEqual(agent.parse_region("中国|江苏省|南京市|0|CN"), ("中国", "江苏省", "南京市", ""))
        self.assertEqual(agent.parse_region("United States|California|0|Google LLC|US"), ("United States", "California", "", "Google LLC"))

    def test_zero_and_empty_fields_are_dropped_and_short_records_tolerated(self):
        self.assertEqual(agent.parse_region("美国|0|0|0|0"), ("美国", "", "", ""))
        self.assertEqual(agent.parse_region("中国|||"), ("中国", "", "", ""))
        self.assertEqual(agent.parse_region("中国"), ("中国", "", "", ""))
        self.assertEqual(agent.parse_region(""), ("", "", "", ""))
        self.assertEqual(agent.parse_region(None), ("", "", "", ""))


class OrgTest(unittest.TestCase):
    def test_company_suffixes_are_trimmed(self):
        self.assertEqual(agent.short_org("Amazon.com, Inc."), "Amazon")
        self.assertEqual(agent.short_org("Google LLC"), "Google")
        self.assertEqual(agent.short_org("Hetzner Online GmbH"), "Hetzner Online")
        self.assertEqual(agent.short_org("Comcast Cable Communications, LLC"), "Comcast Cable Communications")
        self.assertEqual(agent.short_org(""), "")
        self.assertEqual(agent.short_org(None), "")


class LocationTest(unittest.TestCase):
    def geo(self, regions=None, cities=None, asns=None):
        return agent.Geo(FakeRegion(regions) if regions is not None else None, FakeMmdb(cities) if cities is not None else None,
                         FakeMmdb(asns) if asns is not None else None)

    def test_china_uses_ip2region_in_chinese(self):
        geo = self.geo({"1.2.3.4": "中国|0|广东省|深圳市|电信"}, {"1.2.3.4": city("CN", "Shenzhen")}, {"1.2.3.4": asn(4134, "Chinanet")})
        self.assertEqual(geo.location("1.2.3.4"), "广东省 深圳市 · 电信")

    def test_a_province_only_mobile_address_and_a_repeated_municipality(self):
        geo = self.geo({"1.1.1.1": "中国|0|江苏省|0|移动", "2.2.2.2": "中国|0|北京|北京|联通", "3.3.3.3": "中国|0|0|0|0"})
        self.assertEqual(geo.location("1.1.1.1"), "江苏省 · 移动")
        self.assertEqual(geo.location("2.2.2.2"), "北京 · 联通")
        self.assertEqual(geo.location("3.3.3.3"), "中国")

    def test_current_upstream_records_give_the_expected_text(self):
        geo = self.geo({"1.1.1.1": "中国|广东省|深圳市|移动|CN", "2.2.2.2": "中国|江苏省|南京市|0|CN", "3.3.3.3": "United States|California|0|Google LLC|US"})
        self.assertEqual(geo.location("1.1.1.1"), "广东省 深圳市 · 移动")
        self.assertEqual(geo.location("2.2.2.2"), "江苏省 南京市")
        self.assertEqual(geo.location("3.3.3.3"), "United States · Google")
        withcity = self.geo({"3.3.3.3": "United States|California|0|Google LLC|US"}, {"3.3.3.3": city("US", "Mountain View")}, {"3.3.3.3": asn(15169, "Google LLC")})
        self.assertEqual(withcity.location("3.3.3.3"), "US, Mountain View · Google")

    def test_elsewhere_uses_dbip_country_city_and_organization(self):
        geo = self.geo({"3.3.3.3": "美国|0|0|0|Amazon"}, {"3.3.3.3": city("US", "Ashburn")}, {"3.3.3.3": asn(16509, "Amazon.com, Inc.")})
        self.assertEqual(geo.location("3.3.3.3"), "US, Ashburn · Amazon")

    def test_a_missing_city_falls_back_to_the_subdivision_then_the_country(self):
        geo = self.geo(None, {"4.4.4.4": city("DE", None, "Bavaria"), "6.6.6.6": city("FR")}, {})
        self.assertEqual(geo.location("4.4.4.4"), "DE, Bavaria")
        self.assertEqual(geo.location("6.6.6.6"), "FR")

    def test_cloudflare_asn_wins_over_every_location(self):
        geo = self.geo({"104.28.1.2": "美国|0|加利福尼亚州|旧金山|Cloudflare"}, {"104.28.1.2": city("US", "San Francisco")}, {"104.28.1.2": asn(13335, "Cloudflare, Inc.")})
        self.assertEqual(geo.location("104.28.1.2"), "Cloudflare")

    def test_ipv6_skips_ip2region(self):
        region = FakeRegion({"2001:db8::1": "中国|0|广东省|深圳市|电信"})
        geo = agent.Geo(region, FakeMmdb({"2001:db8::1": city("JP", "Tokyo")}), None)
        self.assertEqual(geo.location("2001:db8::1"), "JP, Tokyo")
        self.assertEqual(region.calls, 0)

    def test_a_foreign_ip2region_answer_is_used_when_dbip_has_nothing(self):
        self.assertEqual(self.geo({"5.5.5.5": "日本|0|0|0|0"}, {}, {}).location("5.5.5.5"), "日本")

    def test_unknown_without_databases_or_hits(self):
        self.assertEqual(self.geo().location("9.9.9.9"), "未知")
        self.assertEqual(self.geo({}, {}, {}).location("9.9.9.9"), "未知")
        self.assertEqual(self.geo({}, {}, {"9.9.9.9": asn(64500, "Example Net Ltd")}).location("9.9.9.9"), "未知 · Example Net")

    def test_garbage_ips_and_the_length_cap(self):
        self.assertEqual(self.geo().location("not-an-ip"), "未知")
        long = self.geo({"1.2.3.4": "中国|0|%s|0|0" % ("省" * 400)})
        self.assertEqual(len(long.location("1.2.3.4")), 256)

    def test_results_are_cached_per_ip(self):
        region = FakeRegion({"1.2.3.4": "中国|0|广东省|深圳市|电信"})
        geo = agent.Geo(region, None, None)
        geo.location("1.2.3.4")
        geo.location("1.2.3.4")
        self.assertEqual(region.calls, 1)
