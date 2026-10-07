#!/usr/bin/env python3
"""Offline delivery boundary tests; never start containers or touch Dev state."""
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("manifest", ROOT / "scripts/fhir-dev-manifest.py")
manifest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manifest)
REVISION = "a" * 40
SERVICES = ("app", "chat", "ingress", "fhir")


class DevDeliveryTest(unittest.TestCase):
    def fixture(self, directory):
        for component in SERVICES:
            Path(directory, component + ".json").write_text(json.dumps({"service": component,
                "revision": REVISION, "image": "ghcr.io/czarmich/openehr-fhir-modeller-" + component + "@sha256:" + "b" * 64}))

    def test_only_exact_repository_digests_and_same_revision_are_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            self.fixture(directory)
            manifest.render(REVISION, directory, directory)
            self.assertIn("APP_IMAGE=ghcr.io/czarmich/openehr-fhir-modeller-app@sha256:", Path(directory, "images.env").read_text())
            original = json.loads(Path(directory, "app.json").read_text())
            for replacement in (dict(original, revision="c" * 40),
                                dict(original, image="ghcr.io/czarmich/openehr-fhir-modeller-app:latest"),
                                dict(original, image="ghcr.io/other/app@sha256:" + "b" * 64)):
                Path(directory, "app.json").write_text(json.dumps(replacement))
                with self.assertRaises(ValueError):
                    manifest.render(REVISION, directory, directory)

    def test_host_guard_rejects_manual_other_repository_and_wrong_host(self):
        with tempfile.TemporaryDirectory() as directory:
            hostname = Path(directory, "hostname")
            hostname.write_text("#!/bin/sh\nprintf '%s\\n' unapproved-host\n")
            hostname.chmod(0o755)
            for actions, repository in (("false", "CzarMich/openehr_FHIR_Modeller"),
                                        ("true", "Other/repository"),
                                        ("true", "CzarMich/openehr_FHIR_Modeller")):
                env = dict(os.environ, PATH=directory + ":" + os.environ["PATH"], GITHUB_ACTIONS=actions, GITHUB_REPOSITORY=repository)
                result = subprocess.run(["bash", str(ROOT / "scripts/deploy-fhir-dev.sh"), REVISION, directory], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)

    def test_immutable_compose_preserves_data_and_private_networks(self):
        env = dict(os.environ, REVISION=REVISION)
        env.update({name.upper() + "_IMAGE": "ghcr.io/czarmich/openehr-fhir-modeller-" + name + "@sha256:" + "b" * 64 for name in SERVICES})
        # Hosted runners do not have the protected Dev env files. Some Compose
        # versions check their existence even with --no-env-resolution; supply
        # empty fixtures without opening the real configuration or starting Docker.
        with tempfile.TemporaryDirectory() as directory:
            empty_env = Path(directory, "empty.env")
            empty_env.write_text("")
            source = (ROOT / "deploy/fhir-dev/compose.yml").read_text()
            for name in ("runtime", "chat"):
                declaration = "env_file: /opt/hygeoniq/projects/openehr-fhir-modeller/config/" + name + ".env"
                self.assertEqual(source.count(declaration), 1)
                source = source.replace(declaration, "env_file: " + str(empty_env))
            compose = Path(directory, "compose.yml")
            compose.write_text(source)
            result = subprocess.run(["docker", "compose", "-f", str(compose), "config", "--format", "json"], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(result.stdout)
        self.assertEqual(config["name"], "openehr-fhir-modeller")
        self.assertEqual(set(config["services"]), set(SERVICES))
        self.assertEqual(config["services"]["app"]["user"], "1000:1000")
        self.assertEqual(config["services"]["fhir"]["user"], "10001:10001")
        self.assertEqual(set(config["services"]["app"]["networks"]), {"default", "ig-dev"})
        self.assertEqual(set(config["services"]["ingress"]["networks"]), {"default", "proxy"})
        for name, service in config["services"].items():
            self.assertNotIn("build", service)
            self.assertTrue(service["read_only"])
            if name != "ingress":
                self.assertFalse(service.get("ports"))
            for volume in service.get("volumes", []):
                if volume["type"] == "bind":
                    self.assertTrue(volume["read_only"])
                    self.assertNotEqual(volume["target"], "/app")
                    self.assertTrue(volume["source"].startswith(("/opt/hygeoniq/projects/openehr-fhir-modeller/config/", "/usr/local/share/ca-certificates/")))
        port = config["services"]["ingress"]["ports"][0]
        self.assertEqual((port["host_ip"], port["published"]), ("127.0.0.1", "18350"))
        for name, volume in config["volumes"].items():
            self.assertTrue(volume["external"])
            self.assertEqual(volume["name"], "openehr-fhir-modeller_" + name)


if __name__ == "__main__":
    unittest.main()
