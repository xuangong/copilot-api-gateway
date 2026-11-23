import hashlib
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest

from support import AGENT_DIR, load_agent

agent = load_agent()
BASH = shutil.which("bash")
BUILD = os.path.join(AGENT_DIR, "build-release.sh")
INSTALL = os.path.join(AGENT_DIR, "install.sh")
VERSION = open(os.path.join(AGENT_DIR, "VERSION")).read().strip()


def sh(args, env=None):
    done = subprocess.run(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
    return done.returncode, done.stdout


def sha256(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


@unittest.skipUnless(BASH, "bash is required")
class ReleaseCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.out = os.path.join(self.tmp, "release")

    def build(self, version=VERSION):
        return sh([BASH, BUILD, version, self.out])


class BuildTest(ReleaseCase):
    def test_the_release_has_the_agent_a_stamped_installer_and_checksums_of_both(self):
        code, output = self.build()
        self.assertEqual(code, 0, output)
        self.assertEqual(sorted(os.listdir(self.out)), ["SHA256SUMS", "install.sh", "trojan-telemetry.py"])
        with open(os.path.join(AGENT_DIR, "trojan-telemetry.py"), "rb") as source, open(os.path.join(self.out, "trojan-telemetry.py"), "rb") as copy:
            self.assertEqual(source.read(), copy.read())
        installer = open(os.path.join(self.out, "install.sh")).read()
        self.assertIn('VERSION="%s"' % VERSION, installer)
        self.assertNotIn("__TELEMETRY_VERSION__", installer)
        self.assertTrue(os.access(os.path.join(self.out, "install.sh"), os.X_OK))
        sums = dict((line.split()[1].lstrip("*"), line.split()[0]) for line in open(os.path.join(self.out, "SHA256SUMS")).read().splitlines())
        self.assertEqual(sums, {"trojan-telemetry.py": sha256(os.path.join(self.out, "trojan-telemetry.py")), "install.sh": sha256(os.path.join(self.out, "install.sh"))})

    def test_the_source_installer_holds_the_placeholder_exactly_once(self):
        self.assertEqual(open(INSTALL).read().count("__TELEMETRY_VERSION__"), 1)

    def test_a_version_that_is_malformed_or_differs_from_the_version_file_is_refused(self):
        self.assertNotEqual(self.build("1.0")[0], 0)
        code, output = self.build("9.9.9")
        self.assertNotEqual(code, 0)
        self.assertIn("VERSION", output)
        self.assertEqual(sh([BASH, BUILD])[0], 2)


class InstallTest(ReleaseCase):
    def setUp(self):
        ReleaseCase.setUp(self)
        self.assertEqual(self.build()[0], 0)
        self.root = os.path.join(self.tmp, "root")
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)

    def env(self, **extra):
        env = dict((k, v) for k, v in os.environ.items() if not k.startswith(("TELEMETRY_", "TROJAN_", "PROBE_", "TOP_", "GEO_", "FAKE_")))
        env.update({"PATH": self.bin + os.pathsep + os.environ["PATH"], "TELEMETRY_PREFIX": self.root, "TELEMETRY_BASE_URL": "file://" + self.out})
        env.update(extra)
        return env

    def install(self, **extra):
        base = {"TELEMETRY_GATEWAY": "https://gw.example", "TELEMETRY_KEY": "tlm_a'b"}
        base.update(extra)
        return sh([BASH, os.path.join(self.out, "install.sh")], self.env(**base))

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def fake_docker(self, text, code=0):
        script = os.path.join(self.bin, "docker")
        with open(script, "w") as handle:
            handle.write('#!/bin/sh\nprintf "%%s\\n" \'%s\'\nexit %d\n' % (text, code))
        os.chmod(script, 0o755)

    def test_installs_the_agent_env_file_units_and_state_directory(self):
        code, output = self.install()
        self.assertEqual(code, 0, output)
        script = self.path("opt", "trojan-telemetry", "trojan-telemetry.py")
        self.assertEqual(sha256(script), sha256(os.path.join(self.out, "trojan-telemetry.py")))
        self.assertTrue(os.access(script, os.X_OK))
        env_file = self.path("etc", "trojan-telemetry.env")
        self.assertEqual(stat.S_IMODE(os.stat(env_file).st_mode), 0o600)
        loaded = {}
        agent.load_env_file(env_file, loaded)
        self.assertEqual(loaded, {"TELEMETRY_GATEWAY": "https://gw.example", "TELEMETRY_KEY": "tlm_a'b"})
        service = open(self.path("etc", "systemd", "system", "trojan-telemetry.service")).read()
        self.assertIn("Type=oneshot", service)
        for line in ("NoNewPrivileges=yes", "PrivateTmp=yes", "TimeoutStartSec=50min"):
            self.assertIn(line, service)
        self.assertRegex(service, r"ExecStart=\S*python3\S* " + re.escape(script) + " run")
        timer = open(self.path("etc", "systemd", "system", "trojan-telemetry.timer")).read()
        self.assertIn("OnCalendar=*-*-* *:05:00", timer)
        self.assertIn("Persistent=true", timer)
        self.assertIn("WantedBy=timers.target", timer)
        self.assertTrue(os.path.isdir(self.path("var", "lib", "trojan-telemetry")))
        self.assertIn("shell history", output)
        self.assertIn("Initial run skipped", output)

    def test_a_checksum_mismatch_aborts_before_anything_is_installed(self):
        with open(os.path.join(self.out, "trojan-telemetry.py"), "a") as handle:
            handle.write("# tampered\n")
        code, output = self.install()
        self.assertNotEqual(code, 0)
        self.assertIn("checksum mismatch", output)
        self.assertFalse(os.path.exists(self.path("opt")))
        self.assertFalse(os.path.exists(self.path("etc")))

    def agent_sha(self):
        return sha256(os.path.join(self.out, "trojan-telemetry.py"))

    def test_a_matching_pinned_agent_hash_installs_and_is_not_saved_in_the_env_file(self):
        code, output = self.install(TELEMETRY_AGENT_SHA256=self.agent_sha().upper())
        self.assertEqual(code, 0, output)
        self.assertNotIn("TELEMETRY_AGENT_SHA256", open(self.path("etc", "trojan-telemetry.env")).read())

    def test_a_pinned_hash_that_differs_from_the_download_aborts_even_when_the_release_checksums_agree(self):
        script = os.path.join(self.out, "trojan-telemetry.py")
        with open(script, "a") as handle:
            handle.write("# swapped\n")
        with open(os.path.join(self.out, "SHA256SUMS"), "w") as handle:
            handle.write("%s  trojan-telemetry.py\n" % sha256(script))
        code, output = self.install(TELEMETRY_AGENT_SHA256="0" * 64)
        self.assertNotEqual(code, 0)
        self.assertIn("pinned", output)
        self.assertFalse(os.path.exists(self.path("opt")))
        self.assertFalse(os.path.exists(self.path("etc")))

    def test_a_pinned_hash_does_not_replace_the_release_checksum_check(self):
        pin = self.agent_sha()
        with open(os.path.join(self.out, "SHA256SUMS"), "w") as handle:
            handle.write("%s  trojan-telemetry.py\n" % ("1" * 64))
        code, output = self.install(TELEMETRY_AGENT_SHA256=pin)
        self.assertNotEqual(code, 0)
        self.assertIn("checksum mismatch", output)
        self.assertFalse(os.path.exists(self.path("opt")))

    def test_the_gateway_and_key_are_required(self):
        for missing in ("TELEMETRY_GATEWAY", "TELEMETRY_KEY"):
            env = self.env(TELEMETRY_GATEWAY="https://gw.example", TELEMETRY_KEY="tlm_x")
            del env[missing]
            code, output = sh([BASH, os.path.join(self.out, "install.sh")], env)
            self.assertNotEqual(code, 0)
            self.assertIn(missing, output)

    def test_values_with_line_breaks_are_refused_so_the_env_file_cannot_be_injected(self):
        code, output = self.install(TELEMETRY_KEY="tlm_x\nTROJAN_USERS=evil")
        self.assertNotEqual(code, 0)
        self.assertIn("line breaks", output)
        self.assertFalse(os.path.exists(self.path("etc")))

    def test_an_unstamped_installer_refuses_to_guess_a_release(self):
        env = self.env(TELEMETRY_GATEWAY="https://gw.example", TELEMETRY_KEY="tlm_x")
        del env["TELEMETRY_BASE_URL"]
        code, output = sh([BASH, INSTALL], env)
        self.assertNotEqual(code, 0)
        self.assertIn("not a release build", output)

    def test_a_container_without_log_rotation_is_warned_about(self):
        self.fake_docker("json-file {}")
        self.assertIn("no log rotation", self.install()[1])
        self.fake_docker('json-file {"max-size":"200m","max-file":"5"}')
        self.assertNotIn("log rotation", self.install()[1])
        self.fake_docker("", 1)
        self.assertIn("was not found", self.install()[1])

    def test_a_key_only_reinstall_checks_the_container_saved_earlier(self):
        script = os.path.join(self.bin, "docker")
        with open(script, "w") as handle:
            handle.write('#!/bin/sh\nfor last; do :; done\nif [ "$last" = "my trojan'"'"'s" ]; then echo "json-file {}"; exit 0; fi\necho "wrong container: $last" >&2\nexit 1\n')
        os.chmod(script, 0o755)
        self.assertEqual(self.install(TROJAN_CONTAINER="my trojan's")[0], 0)
        code, output = self.install(TELEMETRY_KEY="tlm_second", TELEMETRY_REPLACE_TROJAN_KEY="1")
        self.assertEqual(code, 0, output)
        self.assertIn("no log rotation", output)
        self.assertNotIn("was not found", output)

    def test_line_breaks_in_optional_values_are_refused_too(self):
        code, output = self.install(TOP_DOMAINS="5\nTELEMETRY_KEY=evil")
        self.assertNotEqual(code, 0)
        self.assertIn("line breaks", output)
        self.assertFalse(os.path.exists(self.path("etc")))

    def test_purge_without_uninstall_is_refused(self):
        code, output = sh([BASH, os.path.join(self.out, "install.sh"), "--purge"], self.env())
        self.assertNotEqual(code, 0)
        self.assertIn("--purge", output)
        self.assertFalse(os.path.exists(self.path("opt")))

    @unittest.skipIf(os.geteuid() == 0, "needs a non-root user")
    def test_uninstall_and_install_without_a_test_prefix_require_root_before_touching_anything(self):
        env = self.env(TELEMETRY_GATEWAY="https://gw.example", TELEMETRY_KEY="tlm_x")
        del env["TELEMETRY_PREFIX"]
        for args in (["--uninstall"], []):
            code, output = sh([BASH, os.path.join(self.out, "install.sh")] + args, env)
            self.assertNotEqual(code, 0)
            self.assertIn("run as root", output)

    def test_reinstalling_replaces_the_key_and_keeps_optional_settings_unless_overridden(self):
        self.assertEqual(self.install(TROJAN_CONTAINER="mytrojan", TOP_DOMAINS="20", TELEMETRY_KEY="tlm_first")[0], 0)
        self.assertEqual(self.install(TELEMETRY_KEY="tlm_second", TELEMETRY_REPLACE_TROJAN_KEY="1")[0], 0)
        loaded = {}
        agent.load_env_file(self.path("etc", "trojan-telemetry.env"), loaded)
        self.assertEqual(loaded, {"TELEMETRY_GATEWAY": "https://gw.example", "TELEMETRY_KEY": "tlm_second", "TROJAN_CONTAINER": "mytrojan", "TOP_DOMAINS": "20"})
        self.assertEqual(self.install(TELEMETRY_KEY="tlm_third", TOP_DOMAINS="5", TELEMETRY_REPLACE_TROJAN_KEY="1")[0], 0)
        loaded = {}
        agent.load_env_file(self.path("etc", "trojan-telemetry.env"), loaded)
        self.assertEqual((loaded["TOP_DOMAINS"], loaded["TROJAN_CONTAINER"], loaded["TELEMETRY_KEY"]), ("5", "mytrojan", "tlm_third"))

    def loaded(self):
        loaded = {}
        agent.load_env_file(self.path("etc", "trojan-telemetry.env"), loaded)
        return loaded

    def test_client_settings_and_extra_source_keys_are_written_in_a_private_env_file(self):
        sites = "dentalrendering=dental.example:dental;museum=museum.example:museum"
        code, output = self.install(TELEMETRY_SITES=sites, TELEMETRY_KEY_DENTALRENDERING="tlm_d", TELEMETRY_KEY_MUSEUM="tlm_m",
                                    TOP_CLIENTS="10", TOP_CLIENT_DOMAINS="5", GEO_DOWNLOAD="0")
        self.assertEqual(code, 0, output)
        self.assertEqual(self.loaded(), {"TELEMETRY_GATEWAY": "https://gw.example", "TELEMETRY_KEY": "tlm_a'b", "TELEMETRY_SITES": sites,
                                         "TELEMETRY_KEY_DENTALRENDERING": "tlm_d", "TELEMETRY_KEY_MUSEUM": "tlm_m", "TOP_CLIENTS": "10",
                                         "TOP_CLIENT_DOMAINS": "5", "GEO_DOWNLOAD": "0"})
        self.assertEqual(stat.S_IMODE(os.stat(self.path("etc", "trojan-telemetry.env")).st_mode), 0o600)

    def test_reinstalling_the_trojan_key_keeps_the_site_keys_and_sites(self):
        sites = "museum=museum.example:museum"
        self.assertEqual(self.install(TELEMETRY_SITES=sites, TELEMETRY_KEY_MUSEUM="tlm_m")[0], 0)
        self.assertEqual(self.install(TELEMETRY_KEY="tlm_new", TELEMETRY_REPLACE_TROJAN_KEY="1")[0], 0)
        loaded = self.loaded()
        self.assertEqual((loaded["TELEMETRY_KEY"], loaded["TELEMETRY_KEY_MUSEUM"], loaded["TELEMETRY_SITES"]), ("tlm_new", "tlm_m", sites))
        self.assertEqual(self.install(TELEMETRY_KEY="tlm_new", TELEMETRY_KEY_MUSEUM="tlm_rotated")[0], 0)
        self.assertEqual(self.loaded()["TELEMETRY_KEY_MUSEUM"], "tlm_rotated")

    def test_telemetry_source_stores_the_key_for_that_source_and_keeps_the_trojan_key(self):
        sites = "dentalrendering=dental.example:dental"
        self.assertEqual(self.install(TELEMETRY_KEY="tlm_trojan", TELEMETRY_SITES=sites)[0], 0)
        code, output = sh([BASH, os.path.join(self.out, "install.sh")],
                          self.env(TELEMETRY_SOURCE="dentalrendering", TELEMETRY_KEY="tlm_dental", TELEMETRY_GATEWAY="https://gw.example"))
        self.assertEqual(code, 0, output)
        self.assertEqual(self.loaded(), {"TELEMETRY_GATEWAY": "https://gw.example", "TELEMETRY_KEY": "tlm_trojan", "TELEMETRY_SITES": sites,
                                         "TELEMETRY_KEY_DENTALRENDERING": "tlm_dental"})
        self.assertNotIn("TELEMETRY_SOURCE", open(self.path("etc", "trojan-telemetry.env")).read())

    def test_telemetry_source_may_leave_out_the_gateway_and_dashes_become_underscores(self):
        self.assertEqual(self.install(TELEMETRY_KEY="tlm_trojan")[0], 0)
        code, output = sh([BASH, os.path.join(self.out, "install.sh")], self.env(TELEMETRY_SOURCE="my-site", TELEMETRY_KEY="tlm_x"))
        self.assertEqual(code, 0, output)
        self.assertEqual(self.loaded()["TELEMETRY_KEY_MY_SITE"], "tlm_x")
        self.assertEqual(self.loaded()["TELEMETRY_GATEWAY"], "https://gw.example")

    def test_telemetry_source_needs_the_trojan_source_installed_first(self):
        code, output = sh([BASH, os.path.join(self.out, "install.sh")],
                          self.env(TELEMETRY_SOURCE="museum", TELEMETRY_KEY="tlm_m", TELEMETRY_GATEWAY="https://gw.example"))
        self.assertNotEqual(code, 0)
        self.assertIn("trojan", output)
        self.assertFalse(os.path.exists(self.path("etc")))

    def test_a_bad_source_name_or_a_line_break_in_a_site_key_is_refused(self):
        for source in ("Museum", "a b", "1x", "x" * 40, "trojan-vm"):
            code, output = self.install(TELEMETRY_SOURCE=source)
            self.assertNotEqual(code, 0, source)
            self.assertIn("TELEMETRY_SOURCE", output)
        code, output = self.install(TELEMETRY_KEY_MUSEUM="tlm_m\nTROJAN_USERS=evil")
        self.assertNotEqual(code, 0)
        self.assertIn("line breaks", output)
        self.assertFalse(os.path.exists(self.path("etc")))

    def test_a_pasted_website_command_cannot_replace_the_saved_trojan_key(self):
        self.assertEqual(self.install(TELEMETRY_KEY="tlm_trojan")[0], 0)
        code, output = self.install(TELEMETRY_KEY="tlm_website")
        self.assertNotEqual(code, 0)
        self.assertIn("TELEMETRY_REPLACE_TROJAN_KEY", output)
        self.assertEqual(self.loaded()["TELEMETRY_KEY"], "tlm_trojan")
        self.assertEqual(self.install(TELEMETRY_KEY="tlm_trojan")[0], 0)  # the same key again is an ordinary update
        self.assertEqual(self.install(TELEMETRY_KEY="tlm_new", TELEMETRY_REPLACE_TROJAN_KEY="1")[0], 0)
        self.assertEqual(self.loaded()["TELEMETRY_KEY"], "tlm_new")

    def test_the_replace_flag_never_applies_with_a_telemetry_source(self):
        self.assertEqual(self.install(TELEMETRY_KEY="tlm_trojan")[0], 0)
        code, output = sh([BASH, os.path.join(self.out, "install.sh")], self.env(TELEMETRY_SOURCE="museum", TELEMETRY_KEY="tlm_m", TELEMETRY_REPLACE_TROJAN_KEY="1"))
        self.assertEqual(code, 0, output)
        self.assertEqual(self.loaded()["TELEMETRY_KEY"], "tlm_trojan")
        self.assertNotIn("TELEMETRY_REPLACE", open(self.path("etc", "trojan-telemetry.env")).read())

    def test_the_sites_check_is_anchored_to_a_source_name(self):
        self.assertEqual(self.install(TELEMETRY_KEY="tlm_trojan", TELEMETRY_SITES="xmuseum=a.example:a")[0], 0)
        code, output = sh([BASH, os.path.join(self.out, "install.sh")], self.env(TELEMETRY_SOURCE="museum", TELEMETRY_KEY="tlm_m"))
        self.assertEqual(code, 0, output)
        self.assertIn("does not list museum", output)

    def test_a_source_that_telemetry_sites_does_not_list_is_warned_about(self):
        self.assertEqual(self.install(TELEMETRY_KEY="tlm_trojan")[0], 0)
        code, output = sh([BASH, os.path.join(self.out, "install.sh")], self.env(TELEMETRY_SOURCE="museum", TELEMETRY_KEY="tlm_m"))
        self.assertEqual(code, 0, output)
        self.assertIn("TELEMETRY_SITES", output)
        self.assertIn("museum", output)

    def test_uninstall_removes_the_program_and_configuration_and_keeps_state_unless_purged(self):
        self.assertEqual(self.install()[0], 0)
        installer = os.path.join(self.out, "install.sh")
        code, output = sh([BASH, installer, "--uninstall"], self.env())
        self.assertEqual(code, 0, output)
        self.assertFalse(os.path.exists(self.path("opt", "trojan-telemetry")))
        self.assertFalse(os.path.exists(self.path("etc", "trojan-telemetry.env")))
        self.assertFalse(os.path.exists(self.path("etc", "systemd", "system", "trojan-telemetry.service")))
        self.assertFalse(os.path.exists(self.path("etc", "systemd", "system", "trojan-telemetry.timer")))
        self.assertTrue(os.path.isdir(self.path("var", "lib", "trojan-telemetry")))
        self.assertEqual(sh([BASH, installer, "--uninstall", "--purge"], self.env())[0], 0)
        self.assertFalse(os.path.exists(self.path("var", "lib", "trojan-telemetry")))

    def test_an_unknown_argument_is_refused(self):
        self.assertNotEqual(sh([BASH, os.path.join(self.out, "install.sh"), "--nope"], self.env())[0], 0)


if __name__ == "__main__":
    unittest.main()
