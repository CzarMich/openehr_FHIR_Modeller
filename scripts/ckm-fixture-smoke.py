#!/usr/bin/env python3
"""Authenticated multi-source CKM acceptance through the independent MCP client."""
import argparse
import importlib.util
import json
from pathlib import Path
import time

spec = importlib.util.spec_from_file_location("mcp_smoke", Path(__file__).with_name("mcp-smoke.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
parser = argparse.ArgumentParser()
parser.add_argument("--url", required=True)
parser.add_argument("--evidence", type=Path, required=True)
parser.add_argument("--rotation-file", type=Path, required=True)
args = parser.parse_args()
client = module.Client(args.url)
client.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "synthetic-ckm-acceptance", "version": "1"}})
client.rpc("notifications/initialized", notify=True)
checks = []
sources = ["default", "basic", "session", "bearer", "api-key"]
discovery = client.tool("ckm_sources")
assert set(discovery["sources"]) == set(sources + ["denied", "redirect"])
assert "fixture-password" not in json.dumps(discovery)
for source in sources:
    found = client.tool("ckm_archetype_search", {"keyword": "fixture", "ckm": source})
    assert found["items"][0]["revision"] == source
    model = client.tool("ckm_archetype_get", {"identifier": "1.2.3", "ckm": source, "format": "adl"})
    assert source in str(model)
    template = client.tool("ckm_template_get", {"identifier": "1.2.3", "ckm": source, "format": "oet"})
    assert source in str(template)
checks.append("Public, Basic, session-header, bearer and API-key search/retrieval stay source-specific")
for kind in ["archetype", "template"]:
    found = client.tool("ckm_federated_search", {"kind": kind, "keyword": "fixture", "sources": list(reversed(sources)), "maxResults": 50})
    assert found["status"] == "COMPLETE" and found["all_sources_responded"]
    assert found["total"] == 5 and found["truncated"]
    assert [row["source"] for row in found["items"]] == sorted(sources)
    assert len({row["revision" if kind == "archetype" else "version"] for row in found["items"]}) == 5
checks.append("Federation retains source identity and distinct versions with honest window totals")
partial = client.tool("ckm_federated_search", {"kind": "archetype", "keyword": "fixture"})
assert partial["status"] == "PARTIAL" and partial["total"] == 5
assert {row["source"] for row in partial["source_results"] if row["status"] == "FAILED"} == {"denied", "redirect"}
assert "fixture-token" not in json.dumps(partial)
client.tool("ckm_archetype_get", {"identifier": "1.2.3", "ckm": "redirect"}, error=True)
client.tool("ckm_federated_search", {"kind": "archetype", "keyword": "fixture", "sources": ["https://unconfigured.example/"]}, error=True)
checks.append("Authentication failures and redirects stay explicit; unconfigured sources are rejected")
args.rotation_file.write_text("fixture-session-rotated\n")
assert client.tool("ckm_archetype_search", {"keyword": "fixture", "ckm": "session"})["items"]
checks.append("Mounted session credential rotation is used on the next request")
args.evidence.write_text(json.dumps({"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "scope": "Isolated HTTPS CKM fixtures; synthetic credentials only", "status": "PASS", "checks": checks}, indent=2) + "\n")
for check in checks:
    print("PASS", check)
