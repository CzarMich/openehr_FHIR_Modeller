#!/usr/bin/env python3
"""Require successful Dev checks for the exact immutable images being promoted."""
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("manifest", Path(__file__).with_name("fhir-dev-manifest.py"))
manifest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manifest)


def verify(revision, images, evidence):
    evidence = Path(evidence)
    with tempfile.TemporaryDirectory() as directory:
        manifest.render(revision, images, directory)
        expected = json.loads(Path(directory, "images.json").read_text())
    if json.loads((evidence / "images.json").read_text()) != expected:
        raise ValueError("Promoted images do not match the successfully deployed Dev digests")
    for name in ("loopback-ready.json", "https-ready.json"):
        if json.loads((evidence / name).read_text()).get("status") != "ready":
            raise ValueError("Dev readiness evidence is not successful")
    checks = json.loads((evidence / "mcp-smoke.json").read_text()).get("checks", [])
    if not checks or any(check.get("status") != "PASS" for check in checks):
        raise ValueError("Dev MCP evidence is incomplete or failed")
    names = {check.get("check") for check in checks}
    if not {"initialize", "tools/list", "repository capability discovery"} <= names:
        raise ValueError("Required Dev MCP checks are absent")
    tools = next(check.get("detail", []) for check in checks if check.get("check") == "tools/list")
    if not {"fhir_project", "fhir_artifact", "fhir_fsh_compile", "fhir_ig"} <= set(tools):
        raise ValueError("Dev FHIR capabilities were not verified")


if __name__ == "__main__":
    verify(*sys.argv[1:])
