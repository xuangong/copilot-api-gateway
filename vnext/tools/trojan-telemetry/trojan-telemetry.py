#!/usr/bin/env python3
"""Hourly telemetry agent for a trojan-go proxy.

For every closed hour it computes per-user, per-domain traffic from `docker logs` and NIC totals from `vnstat`, keeps the
result in an outbox, pushes the outbox to a gateway (POST /api/telemetry/push) and probes the proxy end to end once per run.
Python 3 standard library only. See docs/telemetry-v1.md.
"""
import argparse
import calendar
import collections
import fcntl
import hashlib
import ipaddress
import json
import mmap
import os
import re
import shlex
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

AGENT_VERSION = "1.1.0"

HOUR = 3600
DAY = 86400
DEFAULT_ENV_FILE = "/etc/trojan-telemetry.env"
DEFAULT_STATE_DIR = "/var/lib/trojan-telemetry"
DEFAULT_CONFIG_PATHS = ["/etc/trojan-go/config.json", "/etc/trojan/config.json"]
BACKFILL_HOURS = 24
OUTBOX_MAX_AGE_DAYS = 7
REJECTED_MAX_AGE_DAYS = 30
MAX_BATCH_HOURS = 24
MAX_BATCH_POINTS = 10000
MAX_BATCH_BYTES = 1536 * 1024
MAX_DIM_VALUE = 256
OTHER = "(other)"
UNKNOWN_USER = "#?"
UNKNOWN_DOMAIN = "(unknown)"
INVALID_DOMAIN = "(invalid)"
# Second-level labels that sit under a two-letter country code (example.co.uk, example.com.cn, x.gov.au).
GENERIC_SECOND_LEVEL = frozenset(["com", "co", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "mil", "ltd", "plc", "nhs", "sch", "nom"])
UNITS = {"B": 1, "KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3, "TB": 1024 ** 4,
         "KiB": 1024, "MiB": 1024 ** 2, "GiB": 1024 ** 3, "TiB": 1024 ** 4}


class ConfigError(Exception):
    pass


class CollectError(Exception):
    pass


def warn(message):
    sys.stderr.write("trojan-telemetry: %s\n" % message)


# ---- time ----

def floor_hour(epoch):
    return epoch - epoch % HOUR


def iso_hour(epoch):
    return time.strftime("%Y-%m-%dT%H:00:00Z", time.gmtime(epoch))


def hour_label(epoch):
    return time.strftime("%Y-%m-%dT%H", time.gmtime(epoch))


def parse_iso(text):
    return calendar.timegm(time.strptime(text, "%Y-%m-%dT%H:%M:%SZ"))


def parse_hour_label(text):
    return calendar.timegm(time.strptime(text, "%Y-%m-%dT%H"))


# ---- configuration ----

def _number(env, name, default, low, high, cast):
    raw = env.get(name, "")
    if raw == "":
        return default
    try:
        value = cast(raw)
    except ValueError:
        raise ConfigError("%s must be a number" % name)
    if value < low or value > high:
        raise ConfigError("%s must be between %s and %s" % (name, low, high))
    return value


def split_target(target):
    """'host:port' or '[v6]:port' -> (host, port string)."""
    if ":" not in target:
        return target, ""
    host, _, port = target.rpartition(":")
    return host.strip("[]"), port


SOURCE_NAME = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
SNI_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$")
SITE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
PRIMARY_SOURCE = "trojan-vm"


def parse_sites(text, reserved):
    """'source=sni:site,sni:site;source2=...' -> [(source, {sni: site})]. Names and SNIs are validated and unique."""
    sources = []
    seen_sni = set(reserved)
    for part in text.split(";"):
        part = part.strip()
        if not part:
            continue
        name, equals, rest = part.partition("=")
        name = name.strip()
        if not equals or not SOURCE_NAME.match(name) or name == PRIMARY_SOURCE or any(name == known for known, _ in sources):
            raise ConfigError("TELEMETRY_SITES: bad or repeated source name '%s'" % name[:40])
        routes = {}
        for item in rest.split(","):
            item = item.strip()
            if not item:
                continue
            sni, colon, site = item.partition(":")
            sni, site = sni.strip().lower(), site.strip()
            if not colon or not SNI_NAME.match(sni) or not SITE_NAME.match(site):
                raise ConfigError("TELEMETRY_SITES: '%s' must look like sni.example:site" % item[:60])
            if sni in seen_sni:
                raise ConfigError("TELEMETRY_SITES: %s is listed twice or is the trojan SNI" % sni)
            seen_sni.add(sni)
            routes[sni] = site
        if not routes:
            raise ConfigError("TELEMETRY_SITES: source %s has no sni:site entries" % name)
        sources.append((name, routes))
    return sources


class Target(object):
    """One telemetry source this agent pushes to: its gateway, push key and outbox directory name."""

    def __init__(self, name, gateway, key, outbox_name):
        self.name = name
        self.gateway = gateway
        self.key = key
        self.outbox_name = outbox_name


class Config(object):
    def __init__(self, env):
        self.gateway = env.get("TELEMETRY_GATEWAY", "").strip().rstrip("/")
        self.key = env.get("TELEMETRY_KEY", "").strip()
        if not self.gateway or not self.key:
            raise ConfigError("TELEMETRY_GATEWAY and TELEMETRY_KEY are required")
        parts = urllib.parse.urlparse(self.gateway)
        if not (parts.scheme == "https" and parts.hostname) and not (parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost", "::1")):
            raise ConfigError("TELEMETRY_GATEWAY must be an https:// URL (plain http only for 127.0.0.1, [::1] or localhost)")
        if parts.query or parts.fragment or "?" in self.gateway or "#" in self.gateway:
            raise ConfigError("TELEMETRY_GATEWAY must not contain a query or fragment")
        self.container = env.get("TROJAN_CONTAINER", "") or "trojan"
        self.iface = env.get("TELEMETRY_IFACE", "") or "eth0"
        self.users = env.get("TROJAN_USERS", "")
        self.config_path = env.get("TROJAN_CONFIG", "")
        self.top_domains = _number(env, "TOP_DOMAINS", 50, 1, 1000, int)
        self.sni = env.get("TROJAN_SNI", "") or "trojan.xianliao.de5.net"
        self.probe_host = env.get("PROBE_HOST", "") or self.sni
        self.probe_port = _number(env, "PROBE_PORT", 443, 1, 65535, int)
        self.probe_target = env.get("PROBE_TARGET", "") or "www.gstatic.com:80"
        host, port = split_target(self.probe_target)
        if not host or not port.isdigit() or not 1 <= int(port) <= 65535:
            raise ConfigError("PROBE_TARGET must be host:port")
        try:
            encoded = host.encode("ascii") if is_ip(host) else host.encode("idna")
        except (UnicodeError, ValueError):
            raise ConfigError("PROBE_TARGET host is not a valid name")
        if not 1 <= len(encoded) <= 255:
            raise ConfigError("PROBE_TARGET host must be at most 255 bytes")
        self.probe_timeout = _number(env, "PROBE_TIMEOUT", 15.0, 0.5, 120.0, float)
        # Test-only: trust this CA file instead of the system store when verifying the proxy certificate.
        self.ca_file = env.get("PROBE_CA_FILE", "") or None
        self.top_clients = _number(env, "TOP_CLIENTS", 50, 1, 1000, int)
        self.top_client_domains = _number(env, "TOP_CLIENT_DOMAINS", 20, 1, 1000, int)
        self.geo_download = env.get("GEO_DOWNLOAD", "") != "0"
        self.targets = [Target(PRIMARY_SOURCE, self.gateway, self.key, "outbox")]
        self.routes = {}
        self.skipped_sources = []
        for name, sites in parse_sites(env.get("TELEMETRY_SITES", ""), [self.sni]):
            key = env.get("TELEMETRY_KEY_" + name.upper().replace("-", "_"), "").strip()
            if not key:
                warn("TELEMETRY_SITES names source %s but TELEMETRY_KEY_%s is not set; that source is skipped" % (name, name.upper().replace("-", "_")))
                self.skipped_sources.append(name)
                continue
            self.targets.append(Target(name, self.gateway, key, "outbox-" + name))
            for sni, site in sites.items():
                self.routes[sni] = (name, site)


def load_env_file(path, environ):
    """Reads KEY='value' lines; variables already in the environment win."""
    try:
        handle = open(path)
    except OSError:
        return
    with handle:
        for raw in handle:
            text = raw.strip()
            if not text or text.startswith("#") or "=" not in text:
                continue
            key, value = text.split("=", 1)
            key = key.strip()
            if not re.match(r"^[A-Z][A-Z0-9_]*$", key):
                continue
            try:
                parts = shlex.split(value)
            except ValueError:
                continue
            environ.setdefault(key, parts[0] if parts else "")


def run_command(args, timeout=300):
    """Returns (returncode, stdout, stderr); a missing executable is 127 and a timeout 124."""
    try:
        done = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except FileNotFoundError:
        return 127, "", "%s: command not found" % args[0]
    except subprocess.TimeoutExpired:
        return 124, "", "%s: timed out" % args[0]
    return done.returncode, done.stdout.decode("utf-8", "replace"), done.stderr.decode("utf-8", "replace")


# ---- users ----

def sha224_hex(password):
    return hashlib.sha224(password.encode("utf-8")).hexdigest()


def read_config_passwords(path):
    with open(path) as handle:
        data = json.load(handle)
    passwords = data.get("password", []) if isinstance(data, dict) else []
    return [p for p in passwords if isinstance(p, str)]


def find_config_path(cfg, runner):
    """TROJAN_CONFIG, else a bind mount of the container that holds config.json, else the usual locations."""
    if cfg.config_path:
        return cfg.config_path
    code, out, _ = runner(["docker", "inspect", "-f", "{{json .Mounts}}", cfg.container])
    if code == 0:
        try:
            mounts = json.loads(out)
        except ValueError:
            mounts = []
        for mount in mounts if isinstance(mounts, list) else []:
            source = mount.get("Source") if isinstance(mount, dict) else None
            if not source:
                continue
            if str(mount.get("Destination", "")).endswith(".json") and os.path.isfile(source):
                return source
            candidate = os.path.join(source, "config.json")
            if os.path.isfile(candidate):
                return candidate
    for path in DEFAULT_CONFIG_PATHS:
        if os.path.isfile(path):
            return path
    return None


def build_user_map(cfg, runner):
    """Returns ({hash: '#n'}, [passwords]). TROJAN_USERS wins over the config's password order."""
    passwords = []
    path = find_config_path(cfg, runner)
    if path:
        try:
            passwords = read_config_passwords(path)
        except (OSError, ValueError) as exc:
            warn("cannot read %s: %s" % (path, exc))
    if cfg.users.strip():
        hashes = [h.lower() for h in re.split(r"[\s,]+", cfg.users.strip()) if h]
        return dict((h, "#%d" % (i + 1)) for i, h in enumerate(hashes)), passwords
    return dict((sha224_hex(p), "#%d" % (i + 1)) for i, p in enumerate(passwords)), passwords


# ---- logs ----

LOG_LINE = re.compile(
    r"user (?P<user>[0-9a-fA-F]+) .*?tunneling to (?P<target>\S+) closed "
    r"sent: (?P<sent>[0-9]+(?:\.[0-9]+)?) (?P<sent_unit>(?:[KMGT]i?)?B) "
    r"recv: (?P<recv>[0-9]+(?:\.[0-9]+)?) (?P<recv_unit>(?:[KMGT]i?)?B)")


def to_bytes(number, unit):
    return int(round(float(number) * UNITS[unit]))


def is_ip(host):
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            socket.inet_pton(family, host)
            return True
        except (OSError, ValueError):
            continue
    return False


def registrable_domain(host):
    """Heuristic without a public suffix list: IPs are kept, otherwise the last 2 labels (3 under a generic second level)."""
    host = host.strip().rstrip(".").lower()
    if not host or is_ip(host):
        return host
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    if len(labels[-1]) == 2 and labels[-2] in GENERIC_SECOND_LEVEL:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def tunnel_domain(host):
    # Hosts on the wire are ASCII (punycode); anything else is garbage and shares one group. The gateway caps a dimension
    # value at 256 characters, so cutting here also keeps duplicates merged.
    return INVALID_DOMAIN if any(ord(ch) > 127 for ch in host) else (registrable_domain(host) or UNKNOWN_DOMAIN)[:MAX_DIM_VALUE]


CONN_LINE = re.compile(
    r"nginx_stream_conn t=\S+ ms=(?P<ms>[0-9]+(?:\.[0-9]+)?) ip=(?P<ip>\S+) port=(?P<port>[0-9]+) "
    r'sni="?(?P<sni>[^"\s]*)"? up=\S+ sent=(?P<sent>[0-9]+) recv=(?P<recv>[0-9]+) dur=(?P<dur>[0-9.]+) st=(?P<st>[0-9]+)')
DOCKER_STAMP = re.compile(r"^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(\.\d+)?Z ")
OWN_STAMP = re.compile(r'time="(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)Z"|\[\w+\]\s+(\d{4})/(\d\d)/(\d\d) (\d\d):(\d\d):(\d\d)')
PRECISE_TOLERANCE = 2.0
SECOND_TOLERANCE = 2.5
MAX_RECORDS = 200000


def normalize_ip(text):
    """Canonical text of an IPv4/IPv6 address (v4-mapped IPv6 becomes IPv4), or None."""
    try:
        address = ipaddress.ip_address(text.strip().strip("[]"))
    except ValueError:
        return None
    mapped = getattr(address, "ipv4_mapped", None)
    return str(mapped if mapped is not None else address)


def client_network(ip):
    """Websites keep only the network: IPv4 /24, IPv6 /48."""
    address = ipaddress.ip_address(ip)
    return str(ipaddress.ip_network("%s/%d" % (ip, 24 if address.version == 4 else 48), strict=False))


def parse_conn_line(raw):
    """One `nginx_stream_conn` record, or None. `sni` is lowercased and '' when missing."""
    match = CONN_LINE.search(raw)
    if not match:
        return None
    ip = normalize_ip(match.group("ip"))
    if ip is None:
        return None
    sni = match.group("sni").lower()
    try:
        dur = float(match.group("dur"))
    except ValueError:
        return None
    return {"ms": float(match.group("ms")), "ip": ip, "port": int(match.group("port")), "sni": "" if sni == "-" else sni,
            "sent": int(match.group("sent")), "recv": int(match.group("recv")), "dur": dur, "status": int(match.group("st"))}


def parse_line_time(raw):
    """(epoch seconds, tolerance) of a log line: Docker's UTC prefix (precise), else the line's own second-precision stamp read as UTC."""
    match = DOCKER_STAMP.match(raw)
    if match:
        whole = calendar.timegm(tuple(int(part) for part in match.groups()[:6]) + (0, 0, 0))
        return whole + float(match.group(7) or 0), PRECISE_TOLERANCE
    match = OWN_STAMP.search(raw)
    if match:
        parts = [part for part in match.groups() if part is not None]
        return calendar.timegm(tuple(int(part) for part in parts) + (0, 0, 0)) + 0.5, SECOND_TOLERANCE
    return None


class LogScan(object):
    """What one pass over an hour of `docker logs` yields: per-user/domain totals (as before), the closed trojan tunnels, the nginx
    connections of the trojan SNI, and per-site aggregates for website SNIs. `routes` maps an SNI to (source, site)."""

    def __init__(self, user_map, routes=None, trojan_sni=None, limit=MAX_RECORDS):
        self.user_map = user_map
        self.routes = routes or {}
        self.trojan_sni = (trojan_sni or "").lower()
        self.limit = limit
        self.totals = {}
        self.tunnels = []
        self.conns = []
        self.sites = {}
        self.dropped = 0

    def add_line(self, raw):
        if "nginx_stream_conn" in raw:
            self.add_conn(raw)
            return
        match = LOG_LINE.search(raw)
        if not match:
            return
        host, _ = split_target(match.group("target"))
        domain = tunnel_domain(host)
        user = self.user_map.get(match.group("user").lower(), UNKNOWN_USER)
        sent = to_bytes(match.group("sent"), match.group("sent_unit"))
        recv = to_bytes(match.group("recv"), match.group("recv_unit"))
        bucket = self.totals.setdefault((user, domain), [0, 0, 0])
        bucket[0] += sent
        bucket[1] += recv
        bucket[2] += 1
        stamp = parse_line_time(raw) if self.trojan_sni else None
        if stamp is not None:
            if len(self.tunnels) < self.limit:
                # The printed size is rounded to 0.005 of its unit, so the real count may be that much lower.
                self.tunnels.append((stamp[0], stamp[1], sent, recv, user, domain, int(0.005 * UNITS[match.group("sent_unit")])))
            else:
                self.dropped += 1

    def add_conn(self, raw):
        record = parse_conn_line(raw)
        if record is None:
            return
        sni = record["sni"]
        if sni and sni == self.trojan_sni:
            if len(self.conns) < self.limit:
                self.conns.append((record["ms"], record["ip"], record["sent"], record["recv"]))
            else:
                self.dropped += 1
        elif sni in self.routes:
            source, site = self.routes[sni]
            key = (source, site, client_network(record["ip"]))
            if key not in self.sites and len(self.sites) >= self.limit:
                self.dropped += 1
                return
            bucket = self.sites.setdefault(key, [0, 0, 0, record["ip"]])
            bucket[0] += record["sent"]
            bucket[1] += record["recv"]
            bucket[2] += 1

    def merge(self, other):
        for key, values in other.totals.items():
            bucket = self.totals.setdefault(key, [0, 0, 0])
            for index in range(3):
                bucket[index] += values[index]
        for key, values in other.sites.items():
            bucket = self.sites.setdefault(key, [0, 0, 0, values[3]])
            for index in range(3):
                bucket[index] += values[index]
        for ours, theirs in ((self.tunnels, other.tunnels), (self.conns, other.conns)):
            room = max(0, self.limit - len(ours))
            ours.extend(theirs[:room])
            self.dropped += max(0, len(theirs) - room)
        self.dropped += other.dropped
        return self


def parse_log_text(text, user_map):
    """{(user, domain): [sent_bytes, recv_bytes, connections]} for every closed-tunnel line. `text` is a string or any iterable of lines."""
    scan = LogScan(user_map)
    for raw in (text.splitlines() if isinstance(text, str) else text):
        scan.add_line(raw)
    return scan.totals


# ---- geo databases ----

class Ip2Region(object):
    """Minimal ip2region xdb searcher (IPv4 only). Layout: 256-byte header, a 256 x 256 vector index of (first, last) segment-index
    pointers (8 bytes each), then regions and the 14-byte segment index entries (start u32, end u32, length u16, pointer u32), all
    little-endian. `data` is bytes or an mmap."""
    HEADER = 256
    VECTOR = 256 * 256 * 8
    BLOCK = 14

    def __init__(self, data, handle=None):
        self.data = data
        self.handle = handle
        if len(data) < self.HEADER + self.VECTOR:
            raise ValueError("not an ip2region database (too small)")
        start, end = struct.unpack_from("<II", data, 8)
        if struct.unpack_from("<H", data, 16)[0] == 6:
            raise ValueError("an IPv6 ip2region database is not supported")
        if not self.HEADER + self.VECTOR <= start <= end or end + self.BLOCK > len(data):
            raise ValueError("ip2region header points outside the file")

    @classmethod
    def open(cls, path):
        handle = open(path, "rb")
        try:
            return cls(mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ), handle)
        except (ValueError, OSError):
            handle.close()
            raise

    def close(self):
        try:
            if hasattr(self.data, "close"):
                self.data.close()
        finally:
            if self.handle is not None:
                self.handle.close()

    def search(self, ip):
        """The region string of an IPv4 address, or None (IPv6, garbage, or no segment)."""
        try:
            address = int(ipaddress.IPv4Address(ip))
        except (ValueError, ipaddress.AddressValueError):
            return None
        cell = self.HEADER + ((address >> 24) & 0xFF) * 256 * 8 + ((address >> 16) & 0xFF) * 8
        first, last = struct.unpack_from("<II", self.data, cell)
        if first == 0 and last == 0:
            return None
        low, high = 0, (last - first) // self.BLOCK
        while low <= high:
            middle = (low + high) // 2
            at = first + middle * self.BLOCK
            if at + self.BLOCK > len(self.data):
                return None
            begin, end, length, pointer = struct.unpack_from("<IIHI", self.data, at)
            if address < begin:
                high = middle - 1
            elif address > end:
                low = middle + 1
            else:
                if pointer + length > len(self.data):
                    return None
                return bytes(self.data[pointer:pointer + length]).decode("utf-8", "replace")
        return None


class Mmdb(object):
    """Minimal MaxMind DB reader: the binary search tree plus the data-section decoder (maps, arrays, strings, integers, doubles,
    booleans and pointers), enough for DB-IP Lite City and ASN. `data` is bytes or an mmap."""
    MARKER = b"\xab\xcd\xefMaxMind.com"
    MAX_DEPTH = 24
    NODE_BUDGET = 20000  # values decoded per lookup, so a hostile file cannot make one lookup run for long

    def __init__(self, data, handle=None):
        self.data = data
        self.handle = handle
        self._spent = 0
        at = data.rfind(self.MARKER, max(0, len(data) - 131072)) if len(data) else -1
        if at < 0:
            raise ValueError("not a MaxMind DB (no metadata)")
        meta_start = at + len(self.MARKER)
        metadata, _ = self.decode(meta_start, meta_start)
        try:
            self.node_count = int(metadata["node_count"])
            self.record_size = int(metadata["record_size"])
            self.ip_version = int(metadata["ip_version"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("MaxMind DB metadata is incomplete")
        if self.record_size not in (24, 28, 32) or self.ip_version not in (4, 6):
            raise ValueError("unsupported MaxMind DB layout")
        self.metadata = metadata
        self.node_bytes = self.record_size // 4
        self.tree_size = self.node_count * self.node_bytes
        self.data_start = self.tree_size + 16
        if self.data_start > at:
            raise ValueError("MaxMind DB search tree is truncated")
        self.ipv4_start = None
        self._spent = 0

    @classmethod
    def open(cls, path):
        handle = open(path, "rb")
        try:
            return cls(mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ), handle)
        except (ValueError, OSError):
            handle.close()
            raise

    def close(self):
        try:
            if hasattr(self.data, "close"):
                self.data.close()
        finally:
            if self.handle is not None:
                self.handle.close()

    def _record(self, node, bit):
        base = node * self.node_bytes
        chunk = self.data[base:base + self.node_bytes]
        if len(chunk) != self.node_bytes:
            raise ValueError("MaxMind DB search tree is truncated")
        if self.record_size == 24:
            return int.from_bytes(chunk[3 * bit:3 * bit + 3], "big")
        if self.record_size == 28:
            if bit == 0:
                return ((chunk[3] & 0xF0) << 20) | int.from_bytes(chunk[0:3], "big")
            return ((chunk[3] & 0x0F) << 24) | int.from_bytes(chunk[4:7], "big")
        return int.from_bytes(chunk[4 * bit:4 * bit + 4], "big")

    def _walk(self, node, value, width):
        for depth in range(width):
            if node >= self.node_count:
                break
            node = self._record(node, (value >> (width - 1 - depth)) & 1)
        return node

    def get(self, ip):
        """The record of an address (a dict), or None."""
        try:
            address = ipaddress.ip_address(ip)
        except ValueError:
            return None
        address = getattr(address, "ipv4_mapped", None) or address
        value = int(address)
        if address.version == 4:
            if self.ip_version == 6:
                if self.ipv4_start is None:
                    self.ipv4_start = self._walk(0, 0, 96)
                node = self._walk(self.ipv4_start, value, 32)
            else:
                node = self._walk(0, value, 32)
        elif self.ip_version == 6:
            node = self._walk(0, value, 128)
        else:
            return None
        if node <= self.node_count:
            return None
        offset = node - self.node_count + self.tree_size
        if offset >= len(self.data):
            raise ValueError("MaxMind DB record points outside the file")
        self._spent = 0
        return self.decode(offset, self.data_start)[0]

    def decode(self, offset, base, depth=0):
        """(value, offset after it). Pointers are relative to `base`, the start of the data section."""
        if depth > self.MAX_DEPTH:
            raise ValueError("MaxMind DB data nests too deeply (a pointer loop?)")
        self._spent += 1
        if self._spent > self.NODE_BUDGET:
            raise ValueError("MaxMind DB record is too large to decode")
        data = self.data
        if offset >= len(data):
            raise ValueError("MaxMind DB data is truncated")
        control = data[offset]
        offset += 1
        kind = control >> 5
        if kind == 1:
            span = (control >> 3) & 3
            width = span + 1
            raw = int.from_bytes(data[offset:offset + width], "big")
            if span == 0:
                target = ((control & 7) << 8) | raw
            elif span == 1:
                target = (((control & 7) << 16) | raw) + 2048
            elif span == 2:
                target = (((control & 7) << 24) | raw) + 526336
            else:
                target = raw
            value, _ = self.decode(base + target, base, depth + 1)
            return value, offset + width
        if kind == 0:
            kind = 7 + data[offset]
            offset += 1
        size = control & 0x1F
        if size == 29:
            size = 29 + data[offset]
            offset += 1
        elif size == 30:
            size = 285 + int.from_bytes(data[offset:offset + 2], "big")
            offset += 2
        elif size == 31:
            size = 65821 + int.from_bytes(data[offset:offset + 3], "big")
            offset += 3
        if kind == 7:
            result = {}
            for _ in range(size):
                key, offset = self.decode(offset, base, depth + 1)
                result[key], offset = self.decode(offset, base, depth + 1)
            return result, offset
        if kind == 11:
            items = []
            for _ in range(size):
                item, offset = self.decode(offset, base, depth + 1)
                items.append(item)
            return items, offset
        if kind == 14:
            return size == 1, offset
        raw = bytes(data[offset:offset + size])
        if len(raw) != size:
            raise ValueError("MaxMind DB data is truncated")
        end = offset + size
        if kind == 2:
            return raw.decode("utf-8", "replace"), end
        if kind == 3:
            return struct.unpack(">d", raw)[0], end
        if kind == 15:
            return struct.unpack(">f", raw)[0], end
        if kind in (5, 6, 9, 10):
            return int.from_bytes(raw, "big"), end
        if kind == 8:
            return struct.unpack(">i", raw.rjust(4, b"\x00"))[0], end
        if kind == 4:
            return raw, end
        raise ValueError("unsupported MaxMind DB type %d" % kind)


# ---- locations ----

UNKNOWN_LOCATION = "未知"
CLOUDFLARE_ASN = 13335
ORG_SUFFIXES = frozenset(["inc", "llc", "ltd", "limited", "corp", "corporation", "gmbh", "co", "sa", "ag", "bv", "plc", "srl", "sas", "oy"])


def parse_region(region):
    """(country, province, city, isp) of an ip2region record. Current upstream is 'country|province|city|isp|CC' (a two-letter code
    last); the older 'country|region|province|city|isp' and 'country|province|city|isp' are read too; '0' and empty fields are dropped."""
    parts = [part.strip() for part in (region or "").split("|")]
    parts = ["" if part == "0" else part for part in parts]
    if len(parts) >= 5 and re.match(r"^[A-Z]{2}$", parts[4]):
        country, province, city, isp = parts[:4]  # current upstream: country|province|city|isp|CC
    elif len(parts) >= 5:
        country, _, province, city, isp = parts[:5]
    elif len(parts) == 4:
        country, province, city, isp = parts
    else:
        country, province, city, isp = (parts + ["", "", "", ""])[:4]
    return country, province, city, isp


def short_org(name):
    """'Amazon.com, Inc.' -> 'Amazon'; a network operator's name without legal suffixes."""
    text = (name or "").split(",")[0].strip()
    words = text.split()
    while len(words) > 1 and words[-1].strip(".").lower() in ORG_SUFFIXES:
        words.pop()
    text = " ".join(words)
    if text.lower().endswith(".com") and len(text) > 4:
        text = text[:-4]
    return text[:40]


def _english(record, key):
    value = record.get(key) if isinstance(record, dict) else None
    names = value.get("names") if isinstance(value, dict) else None
    return names.get("en", "") if isinstance(names, dict) else ""


GEO_MAX_AGE_DAYS = 35
GEO_RETRY_SECONDS = 6 * HOUR
GEO_DOWNLOAD_DEADLINE = 900
IP2REGION_BASE = "https://raw.githubusercontent.com/lionsoul2014/ip2region/master/data/"
DBIP_BASE = "https://download.db-ip.com/free/"
GEO_FILES = (  # (kind, file name, size cap of the decompressed file, gzip, reader class)
    ("ip2region", "ip2region.xdb", 64 * 1024 * 1024, False, Ip2Region),
    ("city", "dbip-city-lite.mmdb", 400 * 1024 * 1024, True, Mmdb),
    ("asn", "dbip-asn-lite.mmdb", 120 * 1024 * 1024, True, Mmdb),
)


def geo_urls(kind, now_epoch):
    """Download candidates, best first. ip2region: the official repository's file (IPv4 only); DB-IP Lite: this month, then last month's."""
    if kind == "ip2region":
        # The plain ip2region.xdb no longer exists upstream; the IPv4 file is the one to fetch.
        return [IP2REGION_BASE + "ip2region_v4.xdb"]
    moment = time.gmtime(now_epoch)
    year, month = moment.tm_year, moment.tm_mon
    previous = (year, month - 1) if month > 1 else (year - 1, 12)
    return [DBIP_BASE + "dbip-%s-lite-%04d-%02d.mmdb.gz" % (kind, y, m) for y, m in ((year, month), previous)]


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _download_url_ok(newurl):
            raise IOError("refusing to follow a redirect to %s" % newurl.split("?")[0])
        return urllib.request.HTTPRedirectHandler.redirect_request(self, req, fp, code, msg, headers, newurl)


def _download_url_ok(url):
    parts = urllib.parse.urlparse(url)
    return parts.scheme == "https" or (parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost", "::1"))


def download_file(url, destination, max_bytes, gunzip, timeout=30, deadline=GEO_DOWNLOAD_DEADLINE):
    """Streams `url` to `destination` (gunzipped on the fly), never more than `max_bytes` decompressed bytes and never longer than
    `deadline` seconds in total. https only (plain http for loopback in tests). Any failure raises IOError and the caller removes the file."""
    if not _download_url_ok(url):
        raise IOError("only https downloads are allowed")
    limit = time.monotonic() + deadline
    opener = urllib.request.build_opener(_SafeRedirect())
    request = urllib.request.Request(url, headers={"User-Agent": "trojan-telemetry/" + AGENT_VERSION})
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if gunzip else None
    written = 0
    try:
        with opener.open(request, timeout=timeout) as response, open(destination, "wb") as out:
            if response.status != 200:
                raise IOError("HTTP %d" % response.status)
            while True:
                if time.monotonic() > limit:
                    raise IOError("download timed out")
                chunk = response.read(65536)
                if not chunk:
                    break
                done = False
                if decoder is not None:
                    chunk = decoder.decompress(chunk, max_bytes - written + 1)
                    if decoder.eof:
                        done = True  # nothing after the end of the gzip stream is read
                    elif decoder.unconsumed_tail:
                        raise IOError("download is larger than %d bytes" % max_bytes)
                written += len(chunk)
                if written > max_bytes:
                    raise IOError("download is larger than %d bytes" % max_bytes)
                out.write(chunk)
                if done:
                    break
            if decoder is not None:
                tail = decoder.flush()
                written += len(tail)
                if written > max_bytes:
                    raise IOError("download is larger than %d bytes" % max_bytes)
                out.write(tail)
    except zlib.error as exc:
        raise IOError("bad gzip data: %s" % exc)
    except (urllib.error.URLError, ValueError) as exc:
        raise IOError(str(exc))


class GeoStore(object):
    """The geo database files in one directory: monthly refresh with fixed URLs, failures keep what is there."""

    def __init__(self, directory, fetcher=None, download=True, clock=time.monotonic):
        self.directory = directory
        self.fetcher = fetcher or download_file
        self.download = download
        self.clock = clock

    def _path(self, name):
        return os.path.join(self.directory, name)

    def refresh(self, now_epoch, budget=GEO_DOWNLOAD_DEADLINE):
        """Downloads what is due. `budget` seconds cover the whole refresh: each download gets what is left, none starts when it is spent."""
        self.spent_at = self.clock() + budget
        if not self.download:
            return
        try:
            os.makedirs(self.directory, mode=0o700, exist_ok=True)
        except OSError as exc:
            warn("cannot create %s: %s" % (self.directory, exc))
            return
        for kind, name, cap, gunzip, reader in GEO_FILES:
            path = self._path(name)
            age = self._age(path, now_epoch) if self._readable(reader, path) else float("inf")
            if age < GEO_MAX_AGE_DAYS * DAY or self._age(path + ".attempt", now_epoch) < GEO_RETRY_SECONDS:
                continue
            if self.spent_at - self.clock() <= 0:
                warn("geo download budget spent; %s waits for the next run" % name)
                continue
            self._touch(path + ".attempt", now_epoch)
            self._fetch(kind, name, cap, gunzip, reader, now_epoch)

    @staticmethod
    def _readable(reader, path):
        """A missing file is simply due; a present but unreadable one counts as missing too (it is replaced after the retry window)."""
        if not os.path.exists(path):
            return True
        try:
            GeoStore._probe(reader, path)
            return True
        except Exception:
            return False

    @staticmethod
    def _age(path, now_epoch):
        try:
            return now_epoch - os.stat(path).st_mtime
        except OSError:
            return float("inf")

    @staticmethod
    def _touch(path, now_epoch):
        try:
            with open(path, "a"):
                pass
            os.utime(path, (now_epoch, now_epoch))
        except OSError:
            pass

    def _fetch(self, kind, name, cap, gunzip, reader, now_epoch):
        path = self._path(name)
        temporary = path + ".download"
        for url in geo_urls(kind, now_epoch):
            try:
                left = self.spent_at - self.clock()
                if left <= 0:
                    raise IOError("download budget spent")
                self.fetcher(url, temporary, cap, gunzip, deadline=left)
                self._probe(reader, temporary)
            except Exception as exc:
                warn("could not refresh %s from %s: %s%s" % (name, url, exc, "; keeping the previous file" if os.path.exists(path) else ""))
                self._discard(temporary)
                continue
            os.replace(temporary, path)
            self._touch(path, now_epoch)
            self._discard(path + ".attempt")
            print("geo: refreshed %s" % name)
            return

    @staticmethod
    def _probe(reader, path):
        opened = reader.open(path)
        opened.close()
        return None

    @staticmethod
    def _discard(path):
        try:
            os.remove(path)
        except OSError:
            pass

    def load(self):
        readers = {}
        for kind, name, cap, gunzip, reader in GEO_FILES:
            path = self._path(name)
            if not os.path.exists(path):
                continue
            try:
                readers[kind] = reader.open(path)
            except Exception as exc:
                warn("ignoring unreadable geo database %s: %s" % (name, exc))
        return Geo(readers.get("ip2region"), readers.get("city"), readers.get("asn"))


class Geo(object):
    """Offline IP to short location text. Any reader may be None (that database is absent)."""

    def __init__(self, ip2region=None, city=None, asn=None):
        self.ip2region = ip2region
        self.city = city
        self.asn = asn
        self.cache = {}

    def close(self):
        for reader in (self.ip2region, self.city, self.asn):
            if reader is not None and hasattr(reader, "close"):
                try:
                    reader.close()
                except Exception:
                    pass

    def location(self, ip):
        found = self.cache.get(ip)
        if found is None:
            if len(self.cache) >= 50000:
                self.cache.clear()
            found = self.cache[ip] = self._lookup(ip)[:MAX_DIM_VALUE]
        return found

    def _lookup(self, ip):
        address = normalize_ip(ip)
        if address is None:
            return UNKNOWN_LOCATION
        is_v4 = "." in address
        record = self._safe(self.asn, "get", address)
        number = record.get("autonomous_system_number") if isinstance(record, dict) else None
        org = short_org(record.get("autonomous_system_organization")) if isinstance(record, dict) else ""
        if number == CLOUDFLARE_ASN:
            return "Cloudflare"
        region = self._safe(self.ip2region, "search", address) if is_v4 else None
        country, province, town, isp = parse_region(region)
        if country == "中国":
            place = " ".join(dict.fromkeys(part for part in (province, town) if part)) or country
            return place + (" · " + isp if isp else "")
        record = self._safe(self.city, "get", address)
        if isinstance(record, dict):
            code = (record.get("country") or {}).get("iso_code", "") if isinstance(record.get("country"), dict) else ""
            subdivisions = record.get("subdivisions")
            sub = _english({"s": subdivisions[0]} if isinstance(subdivisions, list) and subdivisions else {}, "s")
            place = ", ".join(part for part in (code, _english(record, "city") or sub) if part)
            if place:
                return place + (" · " + org if org else "")
        if country:
            extra = org or short_org(isp)
            return country + (" · " + extra if extra else "")
        return UNKNOWN_LOCATION + (" · " + org if org else "")

    @staticmethod
    def _safe(reader, method, address):
        if reader is None:
            return None
        try:
            return getattr(reader, method)(address)
        except Exception as exc:  # a damaged database must not stop the hour
            warn("geo lookup failed: %s" % exc)
            return None


# ---- client correlation ----

TLS_RATIO = 1.15
TLS_SLACK = 8 * 1024
UNMATCHED = "(unmatched)"


def correlate(tunnels, conns):
    """Attributes trojan tunnels to nginx connections. Returns ([client ip or None per tunnel], matched count).

    A tunnel (time, tolerance, sent, recv, user, domain, slack) may take an unused connection (ms epoch, ip, sent, recv) whose close time is
    within the tunnel's tolerance and whose nginx `sent` is at least the tunnel's (less its rounding slack) and within 15 percent or 8 KiB above it (nginx counts
    TLS records, trojan-go the payload). The best candidate has the smallest time gap, then the smallest relative byte difference;
    tunnels choose in order of their bytes, largest first, and every connection is used once.
    """
    buckets = {}
    for index, record in enumerate(conns):
        buckets.setdefault(int(record[0]), []).append(index)
    used = set()
    result = [None] * len(tunnels)
    matched = 0
    order = sorted(range(len(tunnels)), key=lambda i: (-(tunnels[i][2] + tunnels[i][3]), i))
    for index in order:
        when, tolerance, sent = tunnels[index][0], tunnels[index][1], tunnels[index][2]
        slack = tunnels[index][6] if len(tunnels[index]) > 6 else 0
        best = None
        for second in range(int(when - tolerance) - 1, int(when + tolerance) + 2):
            for candidate in buckets.get(second, ()):
                if candidate in used:
                    continue
                stamp, _, nginx_sent, _ = conns[candidate]
                gap = abs(stamp - when)
                if gap > tolerance + 1e-9 or nginx_sent < sent - slack:
                    continue
                if nginx_sent > sent * TLS_RATIO and nginx_sent - sent > TLS_SLACK:
                    continue
                rank = (gap, abs(nginx_sent - sent) / float(max(sent, 1)), candidate)
                if best is None or rank < best[0]:
                    best = (rank, candidate)
        if best is not None:
            used.add(best[1])
            result[index] = conns[best[1]][1]
            matched += 1
    return result, matched


def match_rate(matched, total):
    """Per mille of the tunnels that found their client; None when there were no tunnels."""
    return None if total <= 0 else matched * 1000 // total


def fold_top(totals, top_n):
    """Keeps each user's top_n domains by total bytes and folds the rest into '(other)'."""
    by_user = {}
    for (user, domain), values in totals.items():
        by_user.setdefault(user, []).append((domain, values))
    folded = {}
    for user, items in by_user.items():
        items.sort(key=lambda item: (-(item[1][0] + item[1][1]), item[0]))
        for domain, values in items[:top_n]:
            folded[(user, domain)] = list(values)
        rest = items[top_n:]
        if rest:
            other = folded.setdefault((user, OTHER), [0, 0, 0])
            for _, values in rest:
                for index in range(3):
                    other[index] += values[index]
    return folded


def point(metric, hour_iso, dims, value, unit):
    entry = {"metric": metric, "hour": hour_iso, "value": value, "unit": unit}
    if dims:
        entry["dims"] = dims
    return entry


def build_proxy_points(hour_epoch, totals, top_n, reserve_points=0, reserve_bytes=0):
    """Proxy points for one hour; the per-user top N is halved until the hour fits one push batch (points and bytes), leaving
    room for the points other builders add to the same hour."""
    label = iso_hour(hour_epoch)
    while True:
        folded = fold_top(totals, top_n)
        points = []
        for (user, domain) in sorted(folded):
            sent, recv, connections = folded[(user, domain)]
            dims = {"user": user, "domain": domain}
            points.append(point("proxy.sent_bytes", label, dict(dims), sent, "bytes"))
            points.append(point("proxy.recv_bytes", label, dict(dims), recv, "bytes"))
            # Both directions leave the VM again, so their sum is this group's share of the outbound traffic.
            points.append(point("proxy.total_bytes", label, dict(dims), sent + recv, "bytes"))
            points.append(point("proxy.connections", label, dict(dims), connections, "count"))
        if (len(points) + reserve_points <= MAX_BATCH_POINTS and points_size(points) + reserve_bytes <= MAX_BATCH_BYTES) or top_n <= 1:
            return points
        top_n = max(1, top_n // 2)



# ---- client and site points ----

RESERVED_POINTS = 8  # NIC totals (3) and the probe (up to 4) join the same hour
RESERVED_BYTES = 2048
CLIENT_MAX_POINTS = 3000
CLIENT_MAX_BYTES = 450 * 1024


def _location(geo, client):
    if client == OTHER:
        return OTHER
    if client == UNMATCHED or geo is None:
        return UNKNOWN_LOCATION
    return geo.location(client)


def fold_clients(groups, top_clients, top_domains):
    """{(client, domain): [bytes, connections]} -> the same with only each hour's top clients by bytes (the unmatched group always stays),
    each client's top domains, and everything else folded into '(other)'."""
    by_client = {}
    for (client, domain), values in groups.items():
        by_client.setdefault(client, []).append((domain, values))
    ranked = sorted((c for c in by_client if c != UNMATCHED), key=lambda c: (-sum(v[0] for _, v in by_client[c]), c))
    keep = set(ranked[:top_clients])
    if UNMATCHED in by_client:
        keep.add(UNMATCHED)
    folded = {}

    def add(key, values):
        bucket = folded.setdefault(key, [0, 0])
        bucket[0] += values[0]
        bucket[1] += values[1]

    for client, items in by_client.items():
        if client not in keep:
            for _, values in items:
                add((OTHER, OTHER), values)
            continue
        items.sort(key=lambda item: (-item[1][0], item[0]))
        for domain, values in items[:top_domains]:
            add((client, domain), values)
        for _, values in items[top_domains:]:
            add((client, OTHER), values)
    return folded


def build_client_points(hour_epoch, scan, geo, top_clients, top_domains):
    """proxy.client_bytes / proxy.client_connections per (client, location, domain) plus the hour's match rate. Top-N is halved
    until the result fits its share of a push batch."""
    if not scan.tunnels:
        return []
    label = iso_hour(hour_epoch)
    clients, matched = correlate(scan.tunnels, scan.conns)
    groups = {}
    for (_, _, sent, recv, _, domain, _), ip in zip(scan.tunnels, clients):
        bucket = groups.setdefault((ip or UNMATCHED, domain), [0, 0])
        bucket[0] += sent + recv
        bucket[1] += 1
    while True:
        folded = fold_clients(groups, top_clients, top_domains)
        points = []
        for (client, domain) in sorted(folded):
            total, connections = folded[(client, domain)]
            dims = {"client": client, "location": _location(geo, client), "domain": domain}
            points.append(point("proxy.client_bytes", label, dict(dims), total, "bytes"))
            points.append(point("proxy.client_connections", label, dict(dims), connections, "count"))
        if (len(points) <= CLIENT_MAX_POINTS and points_size(points) <= CLIENT_MAX_BYTES) or (top_clients <= 1 and top_domains <= 1):
            break
        top_clients, top_domains = max(1, top_clients // 2), max(1, top_domains // 2)
    points.append(point("proxy.client_match_rate", label, {}, match_rate(matched, len(scan.tunnels)), "count"))
    return points


def build_site_points(hour_epoch, scan, geo, source, top_clients):
    """site.sent_bytes / site.recv_bytes / site.connections per (site, client network, location) for one website source."""
    label = iso_hour(hour_epoch)
    by_site = {}
    for (name, site, network), values in scan.sites.items():
        if name == source:
            by_site.setdefault(site, {})[network] = values
    while True:
        points = []
        for site in sorted(by_site):
            networks = by_site[site]
            ranked = sorted(networks, key=lambda n: (-(networks[n][0] + networks[n][1]), n))
            rows = [(network, networks[network][:3], _location(geo, networks[network][3])) for network in ranked[:top_clients]]
            rest = ranked[top_clients:]
            if rest:
                rows.append((OTHER, [sum(networks[n][i] for n in rest) for i in range(3)], OTHER))
            for network, (sent, recv, connections), location in rows:
                dims = {"site": site, "client": network, "location": location}
                points.append(point("site.sent_bytes", label, dict(dims), sent, "bytes"))
                points.append(point("site.recv_bytes", label, dict(dims), recv, "bytes"))
                points.append(point("site.connections", label, dict(dims), connections, "count"))
        if (len(points) <= MAX_BATCH_POINTS and points_size(points) <= MAX_BATCH_BYTES) or top_clients <= 1:
            return points
        top_clients = max(1, top_clients // 2)


# ---- NIC totals ----

def parse_vnstat(text, iface):
    """{utc hour epoch: (rx_bytes, tx_bytes)} from `vnstat --json h`. JSON v1 counts KiB, v2 bytes; hours are local time unless a timestamp is given."""
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise CollectError("vnstat returned invalid JSON: %s" % exc)
    legacy = str(data.get("jsonversion", "2")).startswith("1")
    scale = 1024 if legacy else 1
    hours = {}
    for entry in data.get("interfaces", []):
        if (entry.get("name") or entry.get("id")) != iface:
            continue
        for row in entry.get("traffic", {}).get("hours" if legacy else "hour", []):
            try:
                stamp = row.get("timestamp")
                if isinstance(stamp, (int, float)) and not isinstance(stamp, bool) and stamp > 0:
                    epoch = int(stamp)  # exact, and immune to DST ambiguity
                else:
                    date = row["date"]
                    hour_of_day = row["time"]["hour"] if "time" in row else row["id"]
                    local = (int(date["year"]), int(date["month"]), int(date["day"]), int(hour_of_day), 0, 0, 0, 0, -1)
                    epoch = int(time.mktime(local))
                hours[floor_hour(epoch)] = (int(round(float(row["rx"]) * scale)), int(round(float(row["tx"]) * scale)))
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
    return hours


class NicTotals(object):
    """vnstat is read once per run, the first time an hour needs it. vnstat may lag up to five minutes behind the clock."""

    def __init__(self, cfg, runner):
        self.cfg = cfg
        self.runner = runner
        self.hours = None

    def get(self, hour_epoch):
        if self.hours is None:
            code, out, err = self.runner(["vnstat", "--json", "h", "-i", self.cfg.iface])
            if code != 0:
                raise CollectError("vnstat failed (%d): %s" % (code, err.strip()[:200]))
            self.hours = parse_vnstat(out, self.cfg.iface)
        return self.hours.get(hour_epoch)


# ---- state ----

REJECTED_DIR = "rejected"
REJECTED_STATUSES = (400, 413)
QUARANTINE_GRACE_HOURS = 2
OUTBOX_NAME = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2})(?:\.probe)?\.json$")


def atomic_write(path, text):
    temporary = path + ".tmp"
    with open(temporary, "w") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    try:  # make the rename durable; best effort (not every platform can fsync a directory)
        descriptor = os.open(os.path.dirname(path) or ".", os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError:
        pass


class State(object):
    """cursor.json holds the last fully processed hour; outbox/ holds computed, unpushed hours."""

    def __init__(self, directory, outbox_name="outbox"):
        self.directory = directory
        self.outbox = os.path.join(directory, outbox_name)
        self.cursor_path = os.path.join(directory, "cursor.json")

    def for_target(self, target):
        """The same state directory (shared cursor) with the outbox of another source."""
        return State(self.directory, target.outbox_name)

    def ensure(self):
        os.makedirs(self.outbox, exist_ok=True)

    def clean_temporaries(self):
        """Removes half-written *.tmp files left by a crash. Call only while holding the lock."""
        outboxes = [os.path.join(self.directory, name) for name in os.listdir(self.directory)
                    if name.startswith("outbox") and os.path.isdir(os.path.join(self.directory, name))]
        for directory in [self.directory] + outboxes:
            for name in os.listdir(directory):
                if name.endswith(".tmp"):
                    try:
                        os.remove(os.path.join(directory, name))
                    except OSError:
                        pass

    def read_cursor(self):
        try:
            with open(self.cursor_path) as handle:
                return floor_hour(parse_iso(json.load(handle)["cursor"]))
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def write_cursor(self, epoch):
        atomic_write(self.cursor_path, json.dumps({"cursor": iso_hour(epoch)}))

    def write_outbox(self, hour_epoch, points, probe=False):
        name = hour_label(hour_epoch) + (".probe.json" if probe else ".json")
        atomic_write(os.path.join(self.outbox, name), json.dumps({"hour": iso_hour(hour_epoch), "points": points}, separators=(",", ":")))

    def list_outbox(self):
        entries = []
        for name in os.listdir(self.outbox):
            match = OUTBOX_NAME.match(name)
            if not match:
                continue
            try:
                entries.append((parse_hour_label(match.group(1)), name))
            except ValueError:
                continue
        entries.sort()
        return entries

    def read_outbox(self, name):
        try:
            with open(os.path.join(self.outbox, name)) as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            return None
        if isinstance(data, dict) and isinstance(data.get("points"), list):
            return data["points"]
        return None

    def remove(self, name):
        try:
            os.remove(os.path.join(self.outbox, name))
        except OSError:
            pass

    @property
    def rejected_dir(self):
        return os.path.join(self.outbox, REJECTED_DIR)

    def reject(self, name):
        """Moves an outbox file the gateway refused to outbox/rejected/ (atomic rename); it is never pushed again."""
        os.makedirs(self.rejected_dir, exist_ok=True)
        os.replace(os.path.join(self.outbox, name), os.path.join(self.rejected_dir, name))

    def list_rejected(self):
        try:
            names = os.listdir(self.rejected_dir)
        except OSError:
            return []
        entries = []
        for name in names:
            match = OUTBOX_NAME.match(name)
            if match:
                try:
                    entries.append((parse_hour_label(match.group(1)), name))
                except ValueError:
                    continue
        entries.sort()
        return entries

    def remove_rejected(self, name):
        try:
            os.remove(os.path.join(self.rejected_dir, name))
        except OSError:
            pass


# ---- streaming `docker logs` ----

def parse_streams(new_scan, streams):
    """One scan of several line iterables (stdout and stderr)."""
    scan = new_scan()
    for stream in streams:
        for raw in stream:
            scan.add_line(raw)
    return scan


def stream_logs(args, new_scan, timeout=300):
    """Runs a command and scans stdout and stderr line by line as they arrive, never holding a whole hour in memory.

    `new_scan()` makes an empty LogScan. Returns (returncode, scan, stderr tail). 127 means the program is missing and 124 that it timed out.
    """
    try:
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8", errors="replace")
    except OSError:
        return 127, new_scan(), "%s: command not found" % args[0]
    tail = collections.deque(maxlen=3)
    results = {}

    def read_stderr():
        err_scan = new_scan()
        try:
            for raw in process.stderr:
                if raw.strip():
                    tail.append(raw.strip()[:200])
                err_scan.add_line(raw)
            results["err"] = err_scan
        except Exception as exc:  # recorded and surfaced below; keep draining so the child never blocks on a full pipe
            results["error"] = "stderr: %s" % exc
            results["err"] = new_scan()
            for _ in process.stderr:
                pass

    expired = threading.Event()

    def kill():
        expired.set()
        process.kill()

    timer = threading.Timer(timeout, kill)
    reader = threading.Thread(target=read_stderr)
    timer.start()
    reader.start()
    out_scan = new_scan()
    try:
        for raw in process.stdout:
            out_scan.add_line(raw)
    except Exception as exc:
        results["error"] = "stdout: %s" % exc
        process.kill()
    finally:
        reader.join()
        process.stdout.close()
        process.stderr.close()
        code = process.wait()
        timer.cancel()
    if "error" in results:
        raise CollectError("cannot read the %s log: %s" % (args[0], results["error"]))
    if expired.is_set():
        return 124, new_scan(), "%s: timed out" % args[0]
    return code, out_scan.merge(results.get("err") or new_scan()), " | ".join(tail)


class SystemRunner(object):
    """Runs the real commands; tests substitute an object with the same call and stream_logs shape."""

    def __call__(self, args, timeout=300):
        return run_command(args, timeout)

    def stream_logs(self, args, new_scan, timeout=300):
        return stream_logs(args, new_scan, timeout)


# ---- collect ----

def docker_logs_args(cfg, hour_epoch):
    """Absolute UTC bounds: Docker stamps its own UTC times, so the container's timezone and the VM's do not matter. `-t` prefixes
    every line with that UTC time, which dates the trojan-go lines precisely for the client correlation."""
    return ["docker", "logs", "--since", iso_hour(hour_epoch), "--until", iso_hour(hour_epoch + HOUR), "-t", "--", cfg.container]


def compute_hour(cfg, user_map, nic, hour_epoch, runner, geo=None):
    """{source name: points} for one hour. The trojan source gets the proxy and NIC points, every other source its own."""
    label = iso_hour(hour_epoch)
    # `docker logs` keeps the container's streams apart and trojan-go may log to either, so both are parsed (streamed, not buffered).
    streamer = getattr(runner, "stream_logs", stream_logs)
    code, scan, err = streamer(docker_logs_args(cfg, hour_epoch), lambda: LogScan(user_map, cfg.routes, cfg.sni))
    if code != 0:
        raise CollectError("docker logs failed (%d): %s" % (code, err.strip()[:200]))
    if scan.dropped:
        warn("%d log record(s) beyond the per-hour cap were not attributed to clients" % scan.dropped)
    client_points = build_client_points(hour_epoch, scan, geo, cfg.top_clients, cfg.top_client_domains)
    points = build_proxy_points(hour_epoch, scan.totals, cfg.top_domains, len(client_points) + RESERVED_POINTS, points_size(client_points) + RESERVED_BYTES)
    points.extend(client_points)
    row = nic.get(hour_epoch)
    if row is not None:
        rx, tx = row
        points.append(point("nic.tx_bytes", label, {}, tx, "bytes"))
        points.append(point("nic.rx_bytes", label, {}, rx, "bytes"))
        # Both directions together: for billing schemes that charge inbound as well as outbound traffic.
        points.append(point("nic.total_bytes", label, {}, rx + tx, "bytes"))
    result = dict((target.name, build_site_points(hour_epoch, scan, geo, target.name, cfg.top_clients)) for target in cfg.targets[1:])
    result[cfg.targets[0].name] = points
    return result


def collect(cfg, state, user_map, runner, now_epoch, geo=None):
    """Processes every closed hour in (cursor, last closed]. Every source's outbox file is written before the cursor moves."""
    last_closed = floor_hour(now_epoch) - HOUR
    cursor = state.read_cursor()
    if cursor is None:
        cursor = last_closed - BACKFILL_HOURS * HOUR
    cursor = max(cursor, last_closed - OUTBOX_MAX_AGE_DAYS * DAY)
    nic = NicTotals(cfg, runner)
    states = [(target, state.for_target(target)) for target in cfg.targets]
    hour = cursor + HOUR
    while hour <= last_closed:
        per_source = compute_hour(cfg, user_map, nic, hour, runner, geo)
        for target, target_state in states:
            target_state.write_outbox(hour, per_source.get(target.name, []), False)
        state.write_cursor(hour)
        hour += HOUR


# ---- push ----

def load_outbox(state):
    entries = []
    for hour_epoch, name in state.list_outbox():
        points = state.read_outbox(name)
        if points is None:
            warn("discarding unreadable outbox file %s" % name)
            state.remove(name)
            continue
        entries.append((hour_epoch, name, points))
    return entries


def discard_expired(state, now_epoch):
    outbox_limit = floor_hour(now_epoch) - OUTBOX_MAX_AGE_DAYS * DAY
    rejected_limit = floor_hour(now_epoch) - REJECTED_MAX_AGE_DAYS * DAY
    for hour_epoch, name in state.list_outbox():
        if hour_epoch < outbox_limit:
            warn("discarding %s: older than %d days" % (name, OUTBOX_MAX_AGE_DAYS))
            state.remove(name)
    for hour_epoch, name in state.list_rejected():
        if hour_epoch < rejected_limit:
            warn("discarding rejected %s: older than %d days" % (name, REJECTED_MAX_AGE_DAYS))
            state.remove_rejected(name)


def points_size(points):
    return sum(len(json.dumps(p, separators=(",", ":"))) + 1 for p in points)


def plan_batches(entries):
    """Groups outbox entries by hour (an hour's hourly and probe files travel together), then fills batches in order."""
    groups = []
    for hour_epoch, name, points in entries:
        if groups and groups[-1]["hour"] == hour_epoch:
            groups[-1]["names"].append(name)
            groups[-1]["points"].extend(points)
        else:
            groups.append({"hour": hour_epoch, "names": [name], "points": list(points)})
    batches = []
    current = None
    for group in groups:
        size = points_size(group["points"])
        count = len(group["points"])
        if current is not None and (len(current["hours"]) >= MAX_BATCH_HOURS or len(current["points"]) + count > MAX_BATCH_POINTS
                                    or current["bytes"] + size > MAX_BATCH_BYTES):
            batches.append(current)
            current = None
        if current is None:
            current = {"hours": [], "names": [], "points": [], "bytes": 0, "groups": []}
        current["groups"].append(group)
        current["hours"].append(group["hour"])
        current["names"].extend(group["names"])
        current["points"].extend(group["points"])
        current["bytes"] += size
    if current is not None:
        batches.append(current)
    return batches


def encode_body(points):
    return json.dumps({"version": 1, "points": points}, separators=(",", ":")).encode("utf-8")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect would replay the push (and its key) somewhere else and could report success for data nobody stored."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def post_points(cfg, points, timeout=30):
    """Returns 200 only when the gateway answered 200 and confirmed storing every point; the HTTP status for other answers
    (redirects included), -1 for a 200 with a missing or wrong confirmation, and 0 when the gateway could not be reached."""
    body = encode_body(points)
    request = urllib.request.Request(cfg.gateway + "/api/telemetry/push", data=body, method="POST", headers={
        "Authorization": "Bearer " + cfg.key, "Content-Type": "application/json", "User-Agent": "trojan-telemetry/" + AGENT_VERSION})
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            status = response.status
            reply = response.read(65536)
    except urllib.error.HTTPError as exc:
        code = exc.code
        exc.close()
        return code
    except (urllib.error.URLError, OSError, ValueError):
        return 0
    if status != 200:
        return status
    try:
        accepted = json.loads(reply.decode("utf-8")).get("accepted")
    except (ValueError, AttributeError):
        return -1
    return 200 if accepted == len(points) and not isinstance(accepted, bool) else -1


def describe_status(status):
    if status > 0:
        return "HTTP %d" % status
    return "unexpected reply" if status < 0 else "gateway unreachable"


def quarantine(state, rejections, now_epoch):
    """Moves refused hours to outbox/rejected/. Returns False when the move failed (the files stay where they are)."""
    recent_from = floor_hour(now_epoch) - QUARANTINE_GRACE_HOURS * 3600
    for group, status in rejections:
        if group["hour"] >= recent_from:
            warn("the gateway rejected recent hour %s (HTTP %d); keeping it for retry in case of clock skew or a transient limit" % (iso_hour(group["hour"]), status))
            continue
        try:
            for name in group["names"]:
                state.reject(name)
        except OSError as exc:
            warn("could not quarantine %s: %s; keeping the remaining files" % (iso_hour(group["hour"]), exc))
            return False
        warn("the gateway rejected hour %s (HTTP %d); moved to outbox/%s/ and not retried" % (iso_hour(group["hour"]), status, REJECTED_DIR))
    return True


def _flatten(groups):
    names = [name for group in groups for name in group["names"]]
    points = [point for group in groups for point in group["points"]]
    return names, points


class _Push(object):
    """One push run: oldest-first batches, a canary on the first refusal, then bisection of refused batches."""

    def __init__(self, cfg, state, poster):
        self.cfg = cfg
        self.state = state
        self.poster = poster
        self.candidates = []
        self.canary = None
        self.canary_ok = False
        self.failed = False

    def send(self, groups):
        return self.poster(self.cfg, _flatten(groups)[1])

    def accept(self, groups):
        names, points = _flatten(groups)
        for name in names:
            self.state.remove(name)
        print("pushed %d hour(s), %d point(s)" % (len(groups), len(points)))
        for group in groups:
            group["done"] = True
            if group is self.canary:
                self.canary_ok = True

    def fail(self, status):
        warn("push failed (%s); the remaining outbox files are kept" % describe_status(status))
        self.failed = True
        return False

    def bisect(self, groups, status):
        """`groups` were refused together with `status`. Returns False when the push must stop."""
        if len(groups) == 1:
            self.candidates.append((groups[0], status))
            return True
        middle = len(groups) // 2
        for half in (groups[:middle], groups[middle:]):
            result = self.send(half)
            if result == 200:
                self.accept(half)
            elif result in REJECTED_STATUSES:
                if not self.bisect(half, result):
                    return False
            else:
                return self.fail(result)
        return True

    @staticmethod
    def pick_canary(batches):
        """The newest hour with a computed hourly file (the open hour often holds only probe points, which prove little about
        the hourly metrics); the newest hour when no hour has one."""
        groups = [group for batch in batches for group in batch["groups"]]
        for group in reversed(groups):
            if any(not name.endswith(".probe.json") for name in group["names"]):
                return group
        return groups[-1] if groups else None

    def run(self, batches):
        """Returns False when the push must stop (a failure or a systemic refusal)."""
        self.canary = self.pick_canary(batches)
        newest = self.canary
        for batch in batches:
            groups = [g for g in batch["groups"] if not g.get("done")]
            if not groups:
                continue
            status = self.send(groups)
            if status == 200:
                self.accept(groups)
                continue
            if status not in REJECTED_STATUSES:
                return self.fail(status)
            if not self.canary_ok:
                if len(groups) == 1 and groups[0] is newest:
                    return self.systemic(status)
                warn("the gateway rejected a batch of %d hour(s) (HTTP %d); sending the newest computed hour alone to check whether the gateway is healthy" % (len(groups), status))
                canary = self.send([newest])
                if canary in REJECTED_STATUSES:
                    return self.systemic(canary)
                if canary != 200:
                    return self.fail(canary)
                self.accept([newest])
                groups = [g for g in groups if g is not newest]
            if groups and not self.bisect(groups, status):
                return False
        return True

    def systemic(self, status):
        warn("the gateway refuses even the canary hour (HTTP %d), which looks systemic (a bad key scope, limits, a VM clock more than about 1 h ahead of the "
             "gateway, or an incompatible gateway); nothing was quarantined and every file is kept" % status)
        self.failed = True
        return False


def push_outbox(cfg, state, poster=None, now_epoch=None):
    """Pushes oldest first in batches; deletes a batch's files after a 200.

    On a 400/413 the newest hour with a computed hourly file (else the newest hour) is sent alone as a canary (at most once per run). If that is refused too the gateway
    refuses everything: the push stops, nothing is quarantined and every file is kept, so such a run costs two requests. If it is
    accepted the gateway is healthy and the refused batch is bisected: halves are pushed, refused halves split further, and an hour
    refused alone is quarantined in outbox/rejected/ (never retried, discarded after REJECTED_MAX_AGE_DAYS) unless it lies within
    QUARANTINE_GRACE_HOURS of the clock. Quarantine runs after the batches; confirmed candidates are quarantined even if a later
    failure stopped the run, because the canary proved the gateway healthy. Any other failure stops the push and keeps the rest.
    Returns True only when everything was pushed and nothing was refused.
    """
    push = _Push(cfg, state, poster or post_points)
    now_epoch = int(time.time()) if now_epoch is None else now_epoch
    complete = push.run(plan_batches(load_outbox(state)))
    if push.candidates:
        quarantine(state, push.candidates, now_epoch)
    return complete and not push.candidates


def warn_about_quarantine(state):
    rejected = state.list_rejected()
    if rejected:
        hours = sorted(set(hour for hour, _ in rejected))
        warn("%d hour(s) in outbox/%s/ (oldest %s); see docs" % (len(hours), REJECTED_DIR, iso_hour(hours[0])))


# ---- lock ----

def acquire_lock(directory):
    """A non-blocking exclusive lock; None when another run holds it."""
    descriptor = os.open(os.path.join(directory, "lock"), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (IOError, OSError):
        os.close(descriptor)
        return None
    return descriptor


# ---- probe ----

def probe(host, port, sni, password, target, timeout, ca_file=None, clock=time.monotonic):
    """One end-to-end check: TCP, TLS (SNI, certificate verified), a trojan CONNECT to `target`, then GET /generate_204.

    Returns ("ok", latency_ms) or ("fail", stage) with stage one of tcp, tls, tunnel, http, timeout.
    """
    started = clock()
    deadline = started + timeout

    def remaining():
        return max(0.05, deadline - clock())

    target_host, target_port = split_target(target)
    host_bytes = target_host.encode("idna")
    request = (sha224_hex(password).encode("ascii") + b"\r\n" + bytes(bytearray([1, 3, len(host_bytes)])) + host_bytes
               + struct.pack(">H", int(target_port)) + b"\r\n")
    request += ("GET /generate_204 HTTP/1.1\r\nHost: %s\r\nConnection: close\r\nUser-Agent: trojan-telemetry\r\n\r\n" % target_host).encode("ascii")
    sock = None
    tls = None
    try:
        try:
            # The timeout covers each connect attempt, not DNS resolution, and every resolved address may use the remaining time.
            sock = socket.create_connection((host, port), timeout=remaining())
        except socket.timeout:
            return ("fail", "timeout")
        except OSError:
            return ("fail", "tcp")
        try:
            context = ssl.create_default_context(cafile=ca_file)
            sock.settimeout(remaining())
            tls = context.wrap_socket(sock, server_hostname=sni)
        except socket.timeout:
            return ("fail", "timeout")
        except (ssl.SSLError, OSError) as exc:
            return ("fail", "timeout" if "timed out" in str(exc) else "tls")
        try:
            tls.settimeout(remaining())
            tls.sendall(request)
            buffer = b""
            while b"\r\n" not in buffer and len(buffer) < 8192:
                tls.settimeout(remaining())
                chunk = tls.recv(4096)
                if not chunk:
                    break
                buffer += chunk
        except socket.timeout:
            return ("fail", "timeout")
        except (ssl.SSLError, OSError):
            return ("fail", "tunnel")
        if not buffer:
            return ("fail", "tunnel")
        if re.match(br"HTTP/1\.[01] 204\b", buffer.split(b"\r\n", 1)[0]):
            return ("ok", int((clock() - started) * 1000))
        return ("fail", "http")
    finally:
        for handle in (tls, sock):
            if handle is not None:
                try:
                    handle.close()
                except OSError:
                    pass


def probe_points(hour_epoch, result):
    label = iso_hour(hour_epoch)
    if result[0] == "ok":
        # probe.fail = 0 (no dims) replaces an earlier failure from the same hour; the gateway ignores zero flags.
        return [point("probe.ok", label, {}, 1, "count"), point("probe.fail", label, {}, 0, "count"),
                point("probe.latency_ms", label, {}, result[1], "ms")]
    return [point("probe.ok", label, {}, 0, "count"), point("probe.fail", label, {"stage": result[1]}, 1, "count")]


def run_probe(cfg, state, passwords, now_epoch, prober=probe):
    """Probes once, attributed to the hour containing the run, as its own outbox file (a second probe replaces the first)."""
    if not passwords:
        warn("no trojan password is readable; skipping the availability probe")
        return
    result = prober(cfg.probe_host, cfg.probe_port, cfg.sni, passwords[0], cfg.probe_target, cfg.probe_timeout, cfg.ca_file)
    hour = floor_hour(now_epoch)
    state.write_outbox(hour, probe_points(hour, result), True)
    print("probe: %s" % (" ".join(str(part) for part in result),))


# ---- command line ----

def geo_store(cfg, state, fetcher=None):
    return GeoStore(os.path.join(state.directory, "geo"), fetcher=fetcher, download=cfg.geo_download)


def open_geo(cfg, state):
    """Opens the geo databases that are there. Problems are warnings: without a database every location is unknown."""
    try:
        return geo_store(cfg, state).load()
    except Exception as exc:
        warn("geo databases unavailable: %s" % exc)
        return Geo()


def refresh_geo(cfg, state, now_epoch, fetcher=None):
    """Downloads due geo databases within one 15 minute budget per run (far below the unit's TimeoutStartSec)."""
    try:
        geo_store(cfg, state, fetcher).refresh(now_epoch)
    except Exception as exc:
        warn("geo refresh failed: %s" % exc)


def run_once(cfg, state, runner, now_epoch, geo_fetcher=None):
    ok = True
    user_map, passwords = build_user_map(cfg, runner)
    for target in cfg.targets:
        state.for_target(target).ensure()
    geo = open_geo(cfg, state)
    try:
        collect(cfg, state, user_map, runner, now_epoch, geo)
    except CollectError as exc:
        warn(str(exc))
        ok = False
    finally:
        geo.close()
    run_probe(cfg, state, passwords, now_epoch)
    for target in cfg.targets:
        target_state = state.for_target(target)
        discard_expired(target_state, now_epoch)
        warn_about_quarantine(target_state)
        # Each source is pushed on its own, so a refusal for one never holds back the others.
        if not push_outbox(target, target_state, now_epoch=now_epoch):
            ok = False
    # Last, so a slow download can never delay an hour's push; the next run uses what it fetched.
    refresh_geo(cfg, state, now_epoch, geo_fetcher)
    return 0 if ok else 1


def main(argv=None, environ=None, runner=None, clock=time.time, geo_fetcher=None):
    runner = runner or SystemRunner()
    env = os.environ if environ is None else environ
    parser = argparse.ArgumentParser(prog="trojan-telemetry", description="Hourly telemetry agent for a trojan-go proxy.")
    parser.add_argument("command", nargs="?", default="run", choices=["run"])
    parser.add_argument("--env-file", default=DEFAULT_ENV_FILE)
    parser.add_argument("--state-dir", default=None)
    parser.add_argument("--now", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--version", action="version", version="trojan-telemetry " + AGENT_VERSION)
    args = parser.parse_args(argv)
    load_env_file(args.env_file, env)
    try:
        cfg = Config(env)
        now_epoch = parse_iso(args.now) if args.now else int(clock())
    except (ConfigError, ValueError) as exc:
        warn("configuration error: %s" % exc)
        return 2
    state = State(args.state_dir or env.get("TELEMETRY_STATE_DIR") or DEFAULT_STATE_DIR)
    state.ensure()
    lock = acquire_lock(state.directory)
    if lock is None:
        return 0
    try:
        state.clean_temporaries()
        return run_once(cfg, state, runner, now_epoch, geo_fetcher)
    finally:
        os.close(lock)


if __name__ == "__main__":
    sys.exit(main())
