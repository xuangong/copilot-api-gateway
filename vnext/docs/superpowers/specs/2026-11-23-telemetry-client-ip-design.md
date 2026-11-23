# Telemetry: client IPs and locations for trojan, dentalrendering and museum

Status: design approved by the owner (2026-11-23).

## Motivation

The trojan VM also hosts the owner's public websites (dentalrendering, museum). All of them sit behind one nginx `stream` block on port 443 that routes by SNI. The owner wants to see where traffic comes from:

- for trojan: which client IP (and where) produced the traffic to each destination domain — e.g. who watched YouTube (`googlevideo.com`);
- for dentalrendering and museum: where their visitors come from, each as its own telemetry page on the central gateway.

The VM's own copilot gateway is out of scope.

trojan-go only sees `127.0.0.1` because nginx proxies the TCP stream; the real client address is known only to nginx. On 2026-11-23 an nginx stream connection log was enabled inside the trojan container (`nginx_stream_conn t=… ms=… ip=… port=… sni="…" up=… sent=… recv=… dur=… st=…`, written to the container's stdout, so it is covered by Docker's json-file rotation).

## Decisions

- **nginx stream log is the source of client addresses** for all sites; trojan-go and the websites are unchanged.
- **The nginx config is persisted** by mounting the stream config from the host in the trojan compose file (a container recreate, a few seconds of proxy downtime; owner confirms during rollout).
- **Geolocation is offline on the VM**: ip2region (China: province / city / ISP, Chinese names) plus DB-IP Lite City and ASN (rest of the world), refreshed monthly by the agent. No IP leaves the VM. Best achievable: city + ISP for fixed broadband, usually province for mobile networks; relays (Cloudflare, WARP, iCloud Private Relay) are labelled as such (Cloudflare ASN 13335 → "Cloudflare").
- **Trojan keeps full client IPs** (the owner's devices and the central Worker). **Websites keep only the network**: IPv4 /24, IPv6 /48, plus location.
- **One agent, several sources.** The existing agent (renamed in docs as the VM telemetry agent, file names unchanged) pushes to multiple telemetry sources, each with its own push key: `trojan-vm` (existing), `dentalrendering` (dental, dental-minio, dental-dev split by a `site` dim), `museum`.
- **Naming IPs.** The dashboard lets the owner name a dim value from the chart/top table (e.g. label a home IP "家里宽带"), using the existing `labels` setting.

## Data

### nginx connection records

Per closed TCP connection: close time (ms), client IP and port, SNI, upstream, bytes sent to the client, bytes received from the client, duration, status. Lines are read hourly from `docker logs` like the trojan lines (same hour bucketing by close time).

### Trojan correlation

trojan-go logs one `… tunneling to <host>:<port> closed sent: <n> recv: <n>` line per tunnel at close (second precision, 1024-based units). Each such line is matched to one nginx connection with SNI = the trojan SNI:

- close times within ±2 s (trojan's second vs nginx's ms);
- nginx `sent` ≥ trojan `sent` and within a TLS-overhead tolerance (nginx counts TLS records; trojan counts payload): ratio between 1.0 and 1.15, or an absolute slack of 8 KiB for small tunnels;
- best match by smallest time gap, then smallest relative byte difference; each nginx record is used at most once (greedy by trojan bytes descending).

Unmatched tunnels get client `(unmatched)`. Match rate per hour is reported as a metric so the owner can see how reliable the attribution is.

### Metrics

| Source | Metric | Unit | Dims |
| --- | --- | --- | --- |
| trojan-vm | `proxy.client_bytes` (sent + recv) | bytes | `client` (full IP or `(unmatched)`), `location`, `domain` (registrable) |
| trojan-vm | `proxy.client_connections` | count | same |
| trojan-vm | `proxy.client_match_rate` | count (per mille) | none |
| dentalrendering | `site.sent_bytes`, `site.recv_bytes`, `site.connections` | bytes / count | `site` (`dental`, `dental-minio`, `dental-dev`), `client` (/24 or /48 network), `location` |
| museum | same as dentalrendering | | `site` (`museum`), `client`, `location` |

`location` is a short string: China "广东省 深圳市 · 电信"; elsewhere "US, Ashburn · Amazon"; relays "Cloudflare"; unknown "未知". Top-N folding keeps each hour within the push limits: top clients by bytes (default 50) and, for trojan, top domains per client (default 20); the rest fold into `(other)`.

Existing metrics are unchanged.

## Agent changes (version 1.1.0)

- Configuration: `TELEMETRY_KEY` stays for the trojan source; new optional `TELEMETRY_SITES` maps sources to SNIs, e.g. `dentalrendering=dental.xianliao.de5.net:dental,dental-minio.xianliao.de5.net:dental-minio,dental-dev.xianliao.de5.net:dental-dev;museum=museum.xianliao.de5.net:museum`, with keys `TELEMETRY_KEY_DENTALRENDERING`, `TELEMETRY_KEY_MUSEUM` (env file, mode 600). The installer accepts them.
- Each source has its own outbox and push state (cursor stays shared: one hour is computed once, producing points for every source).
- Geo databases live in `/var/lib/trojan-telemetry/geo/`, downloaded on first run and refreshed when older than 35 days, from fixed HTTPS URLs (ip2region xdb from its GitHub release, DB-IP Lite monthly files); download failures keep the previous files and log a warning; without any database, `location` is `未知`.
- Readers: a minimal pure-Python ip2region xdb searcher and a minimal MMDB reader (Python 3.8 standard library only), with tests against small fixture files.
- Agent pinning and release as before (`telemetry-agent-v1.1.0`, built locally while GitHub Actions is unavailable; hashes pinned in the gateway).

## Gateway and dashboard

- No schema change. New sources are created in the dashboard; their install command includes the extra keys.
- Telemetry page: clicking a dim value in the top table offers "Name this value…", which writes `labels[dimKey][value]` (same validation as the settings form).

## nginx persistence (rollout)

Move `/etc/nginx/modules-enabled/stream-sni.conf` (with the log lines) to the host next to the trojan compose file and mount it read-only; recreate the container (owner confirms; proxy down a few seconds; SSH over trojan drops briefly).

## Testing

- Parsing nginx lines (IPv4/IPv6, missing SNI), hour bucketing.
- Correlation: exact and tolerance matches, ties, unmatched, one-to-one use, match rate.
- Network truncation (/24, /48), location formatting, relay labelling, unknown.
- ip2region and MMDB readers on fixtures; database refresh (age, failure keeps old files).
- Multi-source outboxes and pushes; per-source keys; installer config.
- End to end: the real agent with fake docker/vnstat output and a fake gateway accepts points for three sources.
- Dashboard: naming a value from the top table.

## Limits

- Mobile networks usually resolve only to the province; relays only to the relay.
- Small concurrent trojan tunnels may be unmatched.
- Websites expose traffic and connections, not paths.
- Data starts after the upgrade; earlier hours have no client information.
