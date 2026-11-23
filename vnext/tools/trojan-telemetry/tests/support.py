"""Test helpers: load the hyphenated agent script as a module."""
import importlib.util
import os
import urllib.parse

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENT_PATH = os.path.join(AGENT_DIR, "trojan-telemetry.py")


def load_agent():
    spec = importlib.util.spec_from_file_location("trojan_telemetry", AGENT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Safety net: no test may reach a real server for a geo database. Only loopback downloads (local test servers) pass.
    allowed = module._download_url_ok
    module._download_url_ok = lambda url: allowed(url) and urllib.parse.urlparse(url).hostname in ("127.0.0.1", "localhost", "::1")
    return module
