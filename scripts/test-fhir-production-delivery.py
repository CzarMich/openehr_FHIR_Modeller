#!/usr/bin/env python3
"""Offline promotion boundary tests; no SSH, credentials or production writes."""
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("promotion", ROOT / "scripts/fhir-promotion-evidence.py")
promotion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promotion)
REVISION = "a" * 40
SERVICES = ("app", "chat", "ingress", "fhir")


class ProductionPromotionTest(unittest.TestCase):
    def fixture(self, directory):
        for component in SERVICES:
            Path(directory, component + ".json").write_text(json.dumps({"service": component,
                "revision": REVISION, "image": "ghcr.io/czarmich/openehr-fhir-modeller-" + component + "@sha256:" + "b" * 64}))
        promotion.manifest.render(REVISION, directory, directory)
        for name in ("loopback-ready.json", "https-ready.json"):
            Path(directory, name).write_text(json.dumps({"status": "ready"}))
        checks = [{"check": name, "status": "PASS"} for name in ("initialize", "repository capability discovery")]
        checks.append({"check": "tools/list", "status": "PASS", "detail": ["fhir_project", "fhir_artifact", "fhir_fsh_compile", "fhir_ig"]})
        Path(directory, "mcp-smoke.json").write_text(json.dumps({"checks": checks}))

    def test_only_exact_images_with_successful_dev_evidence_can_be_promoted(self):
        with tempfile.TemporaryDirectory() as directory:
            self.fixture(directory)
            promotion.verify(REVISION, directory, directory)
            images = json.loads(Path(directory, "images.json").read_text())
            images["images"]["fhir"] = images["images"]["fhir"].replace("b" * 64, "c" * 64)
            Path(directory, "images.json").write_text(json.dumps(images))
            with self.assertRaises(ValueError):
                promotion.verify(REVISION, directory, directory)
            self.fixture(directory)
            Path(directory, "mcp-smoke.json").write_text('{"checks":[{"check":"initialize","status":"FAIL"}]}')
            with self.assertRaises(ValueError):
                promotion.verify(REVISION, directory, directory)
            self.fixture(directory)
            Path(directory, "https-ready.json").write_text('{"status":"unavailable"}')
            with self.assertRaises(ValueError):
                promotion.verify(REVISION, directory, directory)

    def test_production_guard_rejects_manual_execution_and_the_dev_host(self):
        with tempfile.TemporaryDirectory() as directory:
            hostname = Path(directory, "hostname")
            hostname.write_text("#!/bin/sh\nprintf '%s\\n' platform\n")
            hostname.chmod(0o755)
            for actions in ("false", "true"):
                env = dict(os.environ, PATH=directory + ":" + os.environ["PATH"], GITHUB_ACTIONS=actions, GITHUB_REPOSITORY="CzarMich/openehr_FHIR_Modeller")
                result = subprocess.run(["bash", str(ROOT / "scripts/deploy-fhir-prod.sh"), REVISION, "123", "CzarMich"], env=env, input="", capture_output=True, text=True)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)

    def test_production_uses_separate_storage_and_only_loopback_ingress(self):
        env = dict(os.environ, REVISION=REVISION)
        env.update({name.upper() + "_IMAGE": "ghcr.io/czarmich/openehr-fhir-modeller-" + name + "@sha256:" + "b" * 64 for name in SERVICES})
        with tempfile.TemporaryDirectory() as directory:
            empty_env = Path(directory, "empty.env")
            empty_env.write_text("")
            source = (ROOT / "deploy/fhir-prod/compose.yml").read_text()
            self.assertNotIn("hygeoniq-proxy", source)
            self.assertNotIn("ig-dev", source)
            self.assertNotIn("192.168.178.20", source)
            for name in ("runtime", "chat"):
                declaration = "env_file: /opt/hygeoniq/projects/openehr-fhir-modeller-prod/config/" + name + ".env"
                self.assertEqual(source.count(declaration), 1)
                source = source.replace(declaration, "env_file: " + str(empty_env))
            compose = Path(directory, "compose.yml")
            compose.write_text(source)
            result = subprocess.run(["docker", "compose", "-f", str(compose), "config", "--format", "json"], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(result.stdout)
        self.assertEqual(config["name"], "openehr-fhir-modeller-prod")
        self.assertEqual(set(config["services"]["app"]["networks"]), {"default", "ig-prod"})
        self.assertEqual(set(config["services"]["ingress"]["networks"]), {"default"})
        for name, service in config["services"].items():
            self.assertNotIn("build", service)
            self.assertTrue(service["read_only"])
            if name != "ingress":
                self.assertFalse(service.get("ports"))
        port = config["services"]["ingress"]["ports"][0]
        self.assertEqual((port["host_ip"], port["published"]), ("127.0.0.1", "18350"))
        for name, volume in config["volumes"].items():
            self.assertTrue(volume["external"])
            self.assertEqual(volume["name"], "openehr-fhir-modeller-prod_" + name)
        engine = config["services"]["fhir"]
        self.assertEqual(engine["mem_limit"], str(2 * 1024 * 1024 * 1024))
        self.assertEqual(engine["group_add"], ["1000"])
        self.assertTrue(engine["environment"]["PATH"].startswith("/opt/fhir-runtime/bin:"))
        self.assertLessEqual(sum(int(service["mem_limit"]) for service in config["services"].values()), 2880 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
