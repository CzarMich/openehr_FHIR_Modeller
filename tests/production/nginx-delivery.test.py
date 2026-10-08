#!/usr/bin/env python3
"""Exercise site ownership and failed-activation recovery in an isolated filesystem."""
import fcntl
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SITE = "openehr-fhir-modeller.sandbox.hygeoniq.com.conf"
MARKER = "# Managed by openehr_FHIR_Modeller production delivery.\n"


class NginxDeliveryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in ("sites-available", "sites-enabled", "bin", "deploy/production"):
            (self.root / name).mkdir(parents=True)
        self.available = self.root / "sites-available" / SITE
        self.enabled = self.root / "sites-enabled" / SITE
        self.backup = self.root / "backup"
        (self.root / "deploy/production" / SITE).write_text(MARKER + "new configuration\n")
        self.script = self.root / "nginx.sh"
        self.lock = self.root / "nginx.lock"
        self.lock.touch()
        self.script.write_text((ROOT / "scripts/fhir-prod-nginx.sh").read_text().replace("/etc/nginx/", str(self.root) + "/").replace("/opt/hygeoniq/fhir-production-tooling/nginx.lock", str(self.lock)).replace("flock --wait 30", "flock --wait 0.1"))
        sudo = self.root / "bin/sudo"
        sudo.write_text("""#!/usr/bin/env python3
import os,subprocess,sys
from pathlib import Path
args=sys.argv[1:]
if args[0]=='-n': args=args[1:]
if args[0]=='nginx':
    flag=Path(os.environ['NGINX_FAIL_ONCE'])
    if flag.exists(): flag.unlink(); sys.exit(1)
    sys.exit(0)
if args[0]=='systemctl': sys.exit(0)
if args[0]=='install':
    args=[item for index,item in enumerate(args) if item not in ('-o','-g') and (index==0 or args[index-1] not in ('-o','-g'))]
sys.exit(subprocess.run(args).returncode)
""")
        sudo.chmod(0o755)
        stat = self.root / "bin/stat"
        stat.write_text("#!/bin/sh\ncase \"$2\" in %u) echo 0;; %u:%g:%a) echo 0:1000:660;; *) exec /usr/bin/stat \"$@\";; esac\n")
        stat.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.root / "bin") + ":" + os.environ["PATH"], NGINX_FAIL_ONCE=str(self.root / "fail-once"))

    def run_helper(self, action):
        return subprocess.run(["bash", str(self.script), action, str(self.backup)], cwd=self.root, env=self.env, capture_output=True, text=True)

    def test_unrelated_site_and_symlink_are_rejected_without_changes(self):
        self.available.write_text("Operator-owned unrelated site\n")
        self.assertNotEqual(self.run_helper("prepare").returncode, 0)
        self.assertEqual(self.available.read_text(), "Operator-owned unrelated site\n")
        self.available.write_text(MARKER + "old configuration\n")
        self.enabled.symlink_to("/etc/nginx/sites-available/another-app")
        self.assertNotEqual(self.run_helper("prepare").returncode, 0)
        self.assertEqual(os.readlink(self.enabled), "/etc/nginx/sites-available/another-app")

    def test_failed_first_activation_removes_only_the_new_site(self):
        self.assertEqual(self.run_helper("prepare").returncode, 0)
        Path(self.env["NGINX_FAIL_ONCE"]).touch()
        self.assertNotEqual(self.run_helper("activate").returncode, 0)
        self.assertFalse(self.available.exists())
        self.assertFalse(self.enabled.is_symlink())

    def test_success_then_rollback_restores_exact_previous_bytes_and_link(self):
        previous = MARKER + "old configuration\n# Keep this exact comment.\n"
        self.available.write_text(previous)
        self.enabled.symlink_to(self.available)
        self.assertEqual(self.run_helper("prepare").returncode, 0)
        activated = self.run_helper("activate")
        self.assertEqual(activated.returncode, 0, activated.stderr)
        self.assertEqual(self.available.read_text(), MARKER + "new configuration\n")
        restored = self.run_helper("restore")
        self.assertEqual(restored.returncode, 0, restored.stderr)
        self.assertEqual(self.available.read_text(), previous)
        self.assertEqual(os.readlink(self.enabled), str(self.available))

    def test_concurrent_operator_change_is_preserved(self):
        self.available.write_text(MARKER + "old configuration\n")
        self.assertEqual(self.run_helper("prepare").returncode, 0)
        self.available.write_text(MARKER + "operator update\n")
        self.assertNotEqual(self.run_helper("activate").returncode, 0)
        self.assertEqual(self.available.read_text(), MARKER + "operator update\n")

    def test_rollback_refuses_a_replaced_enabled_site_target(self):
        self.assertEqual(self.run_helper("prepare").returncode, 0)
        self.assertEqual(self.run_helper("activate").returncode, 0)
        self.enabled.unlink()
        self.enabled.symlink_to("/etc/nginx/sites-available/another-app")
        self.assertNotEqual(self.run_helper("restore").returncode, 0)
        self.assertEqual(os.readlink(self.enabled), "/etc/nginx/sites-available/another-app")
        self.assertEqual(self.available.read_text(), MARKER + "new configuration\n")

    def test_shared_lock_blocks_a_competing_site_change(self):
        with self.lock.open("r+") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            result = self.run_helper("prepare")
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertFalse(self.available.exists())


if __name__ == "__main__":
    unittest.main()
