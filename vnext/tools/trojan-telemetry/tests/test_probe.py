import json
import os
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import unittest

from support import load_agent
from test_runner import NOW, RunnerCase

agent = load_agent()
OPENSSL = shutil.which("openssl")


class FakeTrojan(object):
    """A TLS server that speaks just enough trojan: it checks the password hash, then answers like a proxy would."""

    def __init__(self, cert, key, mode="ok", password="secret"):
        self.mode = mode
        self.password_hash = agent.sha224_hex(password).encode("ascii")
        self.requests = []
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.load_cert_chain(cert, key)
        self.listener = socket.socket()
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(5)
        self.port = self.listener.getsockname()[1]
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            try:
                connection, _ = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self.handle, args=(connection,), daemon=True).start()

    def handle(self, connection):
        try:
            if self.mode == "plain":
                connection.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
                return
            tls = self.context.wrap_socket(connection, server_side=True)
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = tls.recv(4096)
                if not chunk:
                    break
                data += chunk
            self.requests.append(data)
            if self.mode == "hang":
                time.sleep(3)
            elif self.mode == "http_error":
                tls.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            elif data.startswith(self.password_hash + b"\r\n"):
                tls.sendall(b"HTTP/1.1 204 No Content\r\n\r\n")
            tls.close()
        except (OSError, ssl.SSLError):
            pass
        finally:
            try:
                connection.close()
            except OSError:
                pass

    def close(self):
        self.listener.close()


def make_certificate(directory):
    conf = os.path.join(directory, "openssl.cnf")
    with open(conf, "w") as handle:
        handle.write("[req]\ndistinguished_name = dn\nx509_extensions = v3\nprompt = no\n[dn]\nCN = localhost\n"
                     "[v3]\nsubjectAltName = DNS:localhost\nbasicConstraints = critical,CA:TRUE\nkeyUsage = digitalSignature,keyCertSign\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid:always\n")
    cert, key = os.path.join(directory, "cert.pem"), os.path.join(directory, "key.pem")
    subprocess.check_call([OPENSSL, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-config", conf],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return cert, key


@unittest.skipUnless(OPENSSL, "openssl is needed to create a test certificate")
class ProbeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        cls.cert, cls.key = make_certificate(cls.dir)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, True)

    def server(self, mode="ok"):
        server = FakeTrojan(self.cert, self.key, mode)
        self.addCleanup(server.close)
        return server

    def probe(self, server, password="secret", sni="localhost", timeout=5.0, ca_file="default"):
        return agent.probe("127.0.0.1", server.port, sni, password, "www.gstatic.com:80", timeout, self.cert if ca_file == "default" else ca_file)

    def test_a_working_proxy_answers_204_and_the_request_is_a_trojan_connect_followed_by_a_get(self):
        server = self.server()
        result = self.probe(server)
        self.assertEqual(result[0], "ok")
        self.assertIsInstance(result[1], int)
        self.assertGreaterEqual(result[1], 0)
        prefix = (agent.sha224_hex("secret").encode("ascii") + b"\r\n" + bytes(bytearray([1, 3, len(b"www.gstatic.com")]))
                  + b"www.gstatic.com" + struct.pack(">H", 80) + b"\r\n")
        self.assertTrue(server.requests[0].startswith(prefix))
        self.assertIn(b"GET /generate_204 HTTP/1.1\r\nHost: www.gstatic.com\r\n", server.requests[0][len(prefix):])

    def test_a_wrong_password_is_closed_without_an_answer_and_fails_at_the_tunnel_stage(self):
        self.assertEqual(self.probe(self.server(), password="wrong"), ("fail", "tunnel"))

    def test_a_non_204_answer_fails_at_the_http_stage(self):
        self.assertEqual(self.probe(self.server("http_error")), ("fail", "http"))

    def test_a_server_that_never_answers_times_out(self):
        started = time.time()
        self.assertEqual(self.probe(self.server("hang"), timeout=0.6), ("fail", "timeout"))
        self.assertLess(time.time() - started, 2.5)

    def test_a_server_that_does_not_speak_tls_fails_at_the_tls_stage(self):
        self.assertEqual(self.probe(self.server("plain")), ("fail", "tls"))

    def test_the_certificate_is_verified_against_the_sni_name_and_the_trust_store(self):
        server = self.server()
        self.assertEqual(self.probe(server, sni="wrong.example"), ("fail", "tls"))
        self.assertEqual(self.probe(server, ca_file=None), ("fail", "tls"))

    def test_a_closed_port_fails_at_the_tcp_stage(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        listener.close()
        self.assertEqual(agent.probe("127.0.0.1", port, "localhost", "secret", "www.gstatic.com:80", 2.0, self.cert), ("fail", "tcp"))


class ProbePointsTest(RunnerCase):
    def cfg(self):
        return agent.Config(self.env)

    def test_success_and_failure_points(self):
        hour = agent.parse_iso("2026-11-16T14:00:00Z")
        self.assertEqual(agent.probe_points(hour, ("ok", 42)), [
            {"metric": "probe.ok", "hour": "2026-11-16T14:00:00Z", "value": 1, "unit": "count"},
            {"metric": "probe.fail", "hour": "2026-11-16T14:00:00Z", "value": 0, "unit": "count"},
            {"metric": "probe.latency_ms", "hour": "2026-11-16T14:00:00Z", "value": 42, "unit": "ms"},
        ])
        self.assertEqual(agent.probe_points(hour, ("fail", "tls")), [
            {"metric": "probe.ok", "hour": "2026-11-16T14:00:00Z", "value": 0, "unit": "count"},
            {"metric": "probe.fail", "hour": "2026-11-16T14:00:00Z", "value": 1, "unit": "count", "dims": {"stage": "tls"}},
        ])

    def test_a_probe_has_its_own_outbox_file_and_a_second_probe_in_the_hour_replaces_the_first(self):
        state = agent.State(self.state_dir)
        state.ensure()
        results = [("ok", 42), ("fail", "tls")]
        seen = []

        def prober(*args):
            seen.append(args)
            return results.pop(0)

        now = agent.parse_iso(NOW)
        agent.run_probe(self.cfg(), state, ["pw1", "pw2"], now, prober)
        self.assertEqual(self.outbox(), ["2026-11-16T14.probe.json"])
        self.assertEqual(seen[0], ("trojan.xianliao.de5.net", 443, "trojan.xianliao.de5.net", "pw1", "www.gstatic.com:80", 15.0, None))
        self.assertEqual([p["metric"] for p in state.read_outbox("2026-11-16T14.probe.json")], ["probe.ok", "probe.fail", "probe.latency_ms"])
        agent.run_probe(self.cfg(), state, ["pw1"], now + 1200, prober)
        self.assertEqual(self.outbox(), ["2026-11-16T14.probe.json"])
        self.assertEqual([p["metric"] for p in state.read_outbox("2026-11-16T14.probe.json")], ["probe.ok", "probe.fail"])

    def test_a_success_after_a_failure_in_the_same_hour_zeroes_the_failure_and_both_bodies_are_valid(self):
        from test_gateway_rules import gateway_rejects
        state = agent.State(self.state_dir)
        state.ensure()
        results = [("fail", "tls"), ("ok", 5)]
        now = agent.parse_iso(NOW)
        bodies = []
        for offset in (0, 600):
            agent.run_probe(self.cfg(), state, ["pw1"], now + offset, lambda *args: results.pop(0))
            bodies.append(agent.encode_body(state.read_outbox("2026-11-16T14.probe.json")))
        for body in bodies:
            self.assertIsNone(gateway_rejects(body, now))
        second = json.loads(bodies[1].decode("utf-8"))["points"]
        self.assertEqual([p for p in second if p["metric"] == "probe.fail"],
                         [{"metric": "probe.fail", "hour": "2026-11-16T14:00:00Z", "value": 0, "unit": "count"}])

    def test_without_a_trojan_password_no_probe_runs(self):
        state = agent.State(self.state_dir)
        state.ensure()
        agent.run_probe(self.cfg(), state, [], agent.parse_iso(NOW), lambda *args: self.fail("must not probe"))
        self.assertEqual(self.outbox(), [])


@unittest.skipUnless(OPENSSL, "openssl is needed to create a test certificate")
class ProbeRunTest(RunnerCase):
    def setUp(self):
        RunnerCase.setUp(self)
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        self.cert, self.key = make_certificate(directory)
        self.config = os.path.join(directory, "config.json")
        with open(self.config, "w") as handle:
            json.dump({"password": ["secret", "other"]}, handle)
        self.set_cursor("2026-11-16T13:00:00Z")

    def configure(self, port):
        self.env.update({"TROJAN_CONFIG": self.config, "PROBE_HOST": "127.0.0.1", "TROJAN_SNI": "localhost", "PROBE_PORT": str(port),
                         "PROBE_CA_FILE": self.cert, "PROBE_TIMEOUT": "5"})

    def test_the_run_probes_and_pushes_the_result_for_the_current_hour(self):
        server = FakeTrojan(self.cert, self.key)
        self.addCleanup(server.close)
        self.configure(server.port)
        code, out = self.run_main()
        self.assertEqual(code, 0)
        points = self.server.requests[0]["body"]["points"]
        self.assertEqual(sorted(p["metric"] for p in points), ["probe.fail", "probe.latency_ms", "probe.ok"])
        self.assertEqual(set(p["hour"] for p in points), {"2026-11-16T14:00:00Z"})
        self.assertEqual([p["value"] for p in points if p["metric"] == "probe.ok"], [1])
        self.assertEqual(self.outbox(), [])
        everything = json.dumps(self.server.requests) + out
        self.assertNotIn("secret", everything)
        self.assertNotIn(agent.sha224_hex("secret"), everything)

    def test_a_failed_probe_is_data_not_a_failed_run(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        listener.close()
        self.configure(port)
        code, _ = self.run_main()
        self.assertEqual(code, 0)
        points = self.server.requests[0]["body"]["points"]
        self.assertEqual([(p["metric"], p["value"], p.get("dims")) for p in points if p["metric"].startswith("probe.")],
                         [("probe.ok", 0, None), ("probe.fail", 1, {"stage": "tcp"})])


if __name__ == "__main__":
    unittest.main()
