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
import json
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

AGENT_VERSION = "1.0.2"

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


def parse_log_text(text, user_map):
    """{(user, domain): [sent_bytes, recv_bytes, connections]} for every closed-tunnel line. `text` is a string or any iterable of lines."""
    totals = {}
    for raw in (text.splitlines() if isinstance(text, str) else text):
        match = LOG_LINE.search(raw)
        if not match:
            continue
        host, _ = split_target(match.group("target"))
        # Hosts on the wire are ASCII (punycode); anything else is garbage and shares one group. The gateway caps a dimension
        # value at 256 characters, so cutting here also keeps duplicates merged.
        domain = INVALID_DOMAIN if any(ord(ch) > 127 for ch in host) else (registrable_domain(host) or UNKNOWN_DOMAIN)[:MAX_DIM_VALUE]
        key = (user_map.get(match.group("user").lower(), UNKNOWN_USER), domain)
        bucket = totals.setdefault(key, [0, 0, 0])
        bucket[0] += to_bytes(match.group("sent"), match.group("sent_unit"))
        bucket[1] += to_bytes(match.group("recv"), match.group("recv_unit"))
        bucket[2] += 1
    return totals


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


def build_proxy_points(hour_epoch, totals, top_n):
    """Proxy points for one hour; the per-user top N is halved until the hour fits one push batch (points and bytes)."""
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
        if (len(points) <= MAX_BATCH_POINTS and sum(len(json.dumps(p, separators=(",", ":"))) + 1 for p in points) <= MAX_BATCH_BYTES) or top_n <= 1:
            return points
        top_n = max(1, top_n // 2)



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

    def __init__(self, directory):
        self.directory = directory
        self.outbox = os.path.join(directory, "outbox")
        self.cursor_path = os.path.join(directory, "cursor.json")

    def ensure(self):
        os.makedirs(self.outbox, exist_ok=True)

    def clean_temporaries(self):
        """Removes half-written *.tmp files left by a crash. Call only while holding the lock."""
        for directory in (self.directory, self.outbox):
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

def merge_totals(parts):
    merged = {}
    for part in parts:
        for key, values in part.items():
            bucket = merged.setdefault(key, [0, 0, 0])
            for index in range(3):
                bucket[index] += values[index]
    return merged


def parse_streams(user_map, streams):
    """Combined totals of several line iterables (stdout and stderr)."""
    return merge_totals(parse_log_text(stream, user_map) for stream in streams)


def stream_logs(args, user_map, timeout=300):
    """Runs a command and parses stdout and stderr line by line as they arrive, never holding a whole hour in memory.

    Returns (returncode, totals, stderr tail). 127 means the program is missing and 124 that it timed out.
    """
    try:
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8", errors="replace")
    except OSError:
        return 127, {}, "%s: command not found" % args[0]
    tail = collections.deque(maxlen=3)
    results = {}

    def read_stderr():
        def lines():
            for raw in process.stderr:
                if raw.strip():
                    tail.append(raw.strip()[:200])
                yield raw
        try:
            results["err"] = parse_log_text(lines(), user_map)
        except Exception as exc:  # recorded and surfaced below; keep draining so the child never blocks on a full pipe
            results["error"] = "stderr: %s" % exc
            results["err"] = {}
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
    out_totals = {}
    try:
        out_totals = parse_log_text(process.stdout, user_map)
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
        return 124, {}, "%s: timed out" % args[0]
    return code, parse_streams_merge(out_totals, results.get("err", {})), " | ".join(tail)


def parse_streams_merge(first, second):
    return merge_totals([first, second])


class SystemRunner(object):
    """Runs the real commands; tests substitute an object with the same call and stream_logs shape."""

    def __call__(self, args, timeout=300):
        return run_command(args, timeout)

    def stream_logs(self, args, user_map, timeout=300):
        return stream_logs(args, user_map, timeout)


# ---- collect ----

def docker_logs_args(cfg, hour_epoch):
    """Absolute UTC bounds: Docker stamps its own UTC times, so the container's timezone and the VM's do not matter."""
    return ["docker", "logs", "--since", iso_hour(hour_epoch), "--until", iso_hour(hour_epoch + HOUR), "--", cfg.container]


def compute_hour(cfg, user_map, nic, hour_epoch, runner):
    label = iso_hour(hour_epoch)
    # `docker logs` keeps the container's streams apart and trojan-go may log to either, so both are parsed (streamed, not buffered).
    streamer = getattr(runner, "stream_logs", stream_logs)
    code, totals, err = streamer(docker_logs_args(cfg, hour_epoch), user_map)
    if code != 0:
        raise CollectError("docker logs failed (%d): %s" % (code, err.strip()[:200]))
    points = build_proxy_points(hour_epoch, totals, cfg.top_domains)
    row = nic.get(hour_epoch)
    if row is not None:
        rx, tx = row
        points.append(point("nic.tx_bytes", label, {}, tx, "bytes"))
        points.append(point("nic.rx_bytes", label, {}, rx, "bytes"))
        # Both directions together: for billing schemes that charge inbound as well as outbound traffic.
        points.append(point("nic.total_bytes", label, {}, rx + tx, "bytes"))
    return points


def collect(cfg, state, user_map, runner, now_epoch):
    """Processes every closed hour in (cursor, last closed]. The outbox file is written before the cursor moves."""
    last_closed = floor_hour(now_epoch) - HOUR
    cursor = state.read_cursor()
    if cursor is None:
        cursor = last_closed - BACKFILL_HOURS * HOUR
    cursor = max(cursor, last_closed - OUTBOX_MAX_AGE_DAYS * DAY)
    nic = NicTotals(cfg, runner)
    hour = cursor + HOUR
    while hour <= last_closed:
        state.write_outbox(hour, compute_hour(cfg, user_map, nic, hour, runner), False)
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

def run_once(cfg, state, runner, now_epoch):
    ok = True
    user_map, passwords = build_user_map(cfg, runner)
    try:
        collect(cfg, state, user_map, runner, now_epoch)
    except CollectError as exc:
        warn(str(exc))
        ok = False
    run_probe(cfg, state, passwords, now_epoch)
    discard_expired(state, now_epoch)
    warn_about_quarantine(state)
    if not push_outbox(cfg, state, now_epoch=now_epoch):
        ok = False
    return 0 if ok else 1


def main(argv=None, environ=None, runner=None, clock=time.time):
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
        return run_once(cfg, state, runner, now_epoch)
    finally:
        os.close(lock)


if __name__ == "__main__":
    sys.exit(main())
