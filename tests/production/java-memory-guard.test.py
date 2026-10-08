#!/usr/bin/env python3
"""Exercise the production admission script with real flock and child processes."""
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "deploy/production/java-memory-guard.sh"


class JavaMemoryGuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fhir-java-guard-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.lock = self.root / "java.lock"
        self.lock.touch(mode=0o660)
        self.java = self.root / "fake-java"
        self.java.write_text("""#!/usr/bin/env python3
import json, pathlib, sys, time
args = sys.argv[1:]
if args in [["-version"], ["--version"]]:
    print('openjdk version "21.0.0"')
elif args[0] == "hold":
    pathlib.Path(args[1]).write_text("started")
    time.sleep(30)
elif args[0] == "fail":
    sys.exit(42)
else:
    pathlib.Path(args[-1]).write_text(json.dumps({"valid": True, "arguments": args[:-1]}))
""")
        self.java.chmod(0o755)
        source = SOURCE.read_text()
        # Substitute fixed deployment paths only in the disposable test copy;
        # production intentionally has no environment-based bypass.
        real_java = next(line for line in source.splitlines() if line.startswith("real_java="))
        source = source.replace(real_java, f"real_java={self.java}", 1)
        source = source.replace("lock=/run/fhir-tooling/java.lock", f"lock={self.lock}", 1)
        self.guard = self.root / "java"
        self.guard.write_text(source)
        self.guard.chmod(0o755)
        self.children = []
        self.addCleanup(self.stop_children)

    def stop_children(self):
        for child in self.children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
            child.communicate(timeout=3)

    def run_guard(self, *args):
        return subprocess.run([str(self.guard), *args], capture_output=True, text=True, timeout=3)

    def hold_lock(self):
        started = self.root / f"started-{len(self.children)}"
        child = subprocess.Popen(
            [str(self.guard), "hold", str(started)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
        )
        self.children.append(child)
        deadline = time.monotonic() + 3
        while not started.exists() and time.monotonic() < deadline:
            if child.poll() is not None:
                self.fail(f"Admission holder exited early: {child.communicate()}")
            time.sleep(0.01)
        self.assertTrue(started.exists(), "Heavy process did not start")
        return child

    def test_arguments_and_success_are_preserved(self):
        output = self.root / "result.json"
        result = self.run_guard("validate", "-Xmx1536m", "file with spaces.json", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(output.read_text()), {
            "valid": True, "arguments": ["validate", "-Xmx1536m", "file with spaces.json"],
        })

    def test_missing_lock_fails_closed_without_creating_it(self):
        self.lock.unlink()
        output = self.root / "result.json"
        result = self.run_guard("validate", str(output))
        self.assertEqual(result.returncode, 78)
        self.assertIn("shared lock", result.stderr)
        self.assertFalse(self.lock.exists())
        self.assertFalse(output.exists())

    def test_competing_process_is_rejected_without_validation_output(self):
        self.hold_lock()
        output = self.root / "must-not-be-valid.json"
        started = time.monotonic()
        result = self.run_guard("validate", str(output))
        self.assertEqual(result.returncode, 75)
        self.assertLess(time.monotonic() - started, 1)
        self.assertIn("another validator or IG Publisher", result.stderr)
        self.assertIn("did not complete successfully", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertFalse(output.exists(), "Rejected work must never emit a valid artifact")

    def test_health_probes_work_while_busy_and_without_lock(self):
        self.hold_lock()
        for arg in ("-version", "--version"):
            result = self.run_guard(arg)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("openjdk", result.stdout)
        self.lock.unlink()
        result = self.run_guard("-version")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_version_flag_with_extra_arguments_cannot_bypass_admission(self):
        self.hold_lock()
        output = self.root / "must-not-run.json"
        result = self.run_guard("-version", str(output))
        self.assertEqual(result.returncode, 75)
        self.assertFalse(output.exists())

    def test_timeout_kills_process_group_and_releases_lock(self):
        child = self.hold_lock()
        os.killpg(child.pid, signal.SIGKILL)
        child.communicate(timeout=3)
        self.assertNotEqual(child.returncode, 0)
        output = self.root / "after-timeout.json"
        result = self.run_guard("validate", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(output.read_text())["valid"])

    def test_java_failure_is_preserved_and_releases_lock(self):
        result = self.run_guard("fail")
        self.assertEqual(result.returncode, 42)
        output = self.root / "after-failure.json"
        result = self.run_guard("validate", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(output.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
