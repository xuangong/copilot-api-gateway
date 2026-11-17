"""Test helpers: load the hyphenated agent script as a module."""
import importlib.util
import os

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENT_PATH = os.path.join(AGENT_DIR, "trojan-telemetry.py")


def load_agent():
    spec = importlib.util.spec_from_file_location("trojan_telemetry", AGENT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
