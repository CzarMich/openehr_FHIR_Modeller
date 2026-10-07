#!/usr/bin/env python3
"""Live native OIDC acceptance against an isolated test deployment.

Provide OIDC_SMOKE_WRITER_TOKEN, OIDC_SMOKE_READER_TOKEN and
OIDC_SMOKE_OTHER_TENANT_TOKEN through protected environment configuration.
Never points at a deployment with real model data. No tokens appear in evidence.
"""
import argparse
import importlib.util
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

spec = importlib.util.spec_from_file_location("mcp_smoke", Path(__file__).with_name("mcp-smoke.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--allow-test-writes", action="store_true", required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--issuer-kind", choices=("external", "fixture"), default="external")
    args = parser.parse_args()
    target = urllib.parse.urlsplit(args.url)
    if target.username or target.password or target.query or target.fragment or not target.hostname:
        parser.error("Use an MCP endpoint without URL credentials or query parameters")
    if target.scheme != "https" and not (target.scheme == "http" and target.hostname in ("localhost", "127.0.0.1", "::1")):
        parser.error("Use HTTPS except for an isolated loopback test endpoint")
    evidence = {"status": "FAIL", "issuer_kind": args.issuer_kind, "checks": []}

    def record(check):
        evidence["checks"].append({"check": check, "status": "PASS"})

    def initialize(client):
        client.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                  "clientInfo": {"name": "oidc-acceptance", "version": "1.0"}})
        client.rpc("notifications/initialized", notify=True)

    def model_api(method, path, bearer, payload=None):
        base = f"{target.scheme}://{target.netloc}"
        body = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(base + path, data=body, method=method,
            headers={"Authorization": "Bearer " + bearer, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            body = error.read()
            try:
                result = json.loads(body)
            except json.JSONDecodeError:
                result = {"response_excerpt": body[:300].decode("utf-8", errors="replace")}
            return error.code, result

    try:
        clients = {}
        for name in ("WRITER", "READER", "OTHER_TENANT"):
            clients[name] = module.Client(args.url, bearer=os.environ["OIDC_SMOKE_" + name + "_TOKEN"])
            initialize(clients[name])
        record("OIDC discovery, JWKS signature verification and MCP initialization")
        writer, reader, other = (clients[name] for name in ("WRITER", "READER", "OTHER_TENANT"))
        assert writer.listing("tools/list", "tools")
        assert reader.tool("model_projects")["capabilities"]["storage"]
        record("Authenticated readers can discover tools and read their repository")
        project = "oidc-acceptance-" + str(time.time_ns())
        denied = reader.tool("model_project_create", {"id": project, "name": "Must be denied"}, error=True)
        assert "WRITE_PERMISSION_REQUIRED" in json.dumps(denied)
        record("Reader cannot create models despite deployment write enablement")
        writer.tool("model_project_create", {"id": project, "name": "Synthetic OIDC acceptance"})
        first = writer.tool("model_artifact_save", {"project": project, "path": "requirements/test.txt", "content": "Synthetic OIDC fixture"})
        assert writer.tool("model_artifact_get", {"project": project, "path": "requirements/test.txt"})["content"] == "Synthetic OIDC fixture"
        updated = writer.tool("model_artifact_save", {"project": project, "path": "requirements/test.txt", "content": "Revised synthetic fixture", "expectedRevision": first["revision"]})
        writer.tool("model_artifact_save", {"project": project, "path": "requirements/test.txt", "content": "Stale fixture", "expectedRevision": first["revision"]}, error=True)
        record("Authorised draft writes, persistence and stale-revision rejection")
        status, listing = model_api("GET", "/api/v1/projects", os.environ["OIDC_SMOKE_WRITER_TOKEN"])
        assert status == 200 and project in {item["id"] for item in listing["projects"]}
        status, artifact = model_api("GET", "/api/v1/artifacts?" + urllib.parse.urlencode({"project": project, "path": "requirements/test.txt"}),
                        os.environ["OIDC_SMOKE_WRITER_TOKEN"])
        assert status == 200 and artifact["content"] == "Revised synthetic fixture"
        status, saved = model_api("PUT", "/api/v1/artifacts?" + urllib.parse.urlencode({"project": project, "path": "requirements/test.txt"}),
                      os.environ["OIDC_SMOKE_WRITER_TOKEN"],
                      {"content": "REST synthetic fixture", "expectedRevision": updated["revision"]})
        assert status == 200 and saved["content"] == "REST synthetic fixture"
        status, conflict = model_api("PUT", "/api/v1/artifacts?" + urllib.parse.urlencode({"project": project, "path": "requirements/test.txt"}),
                         os.environ["OIDC_SMOKE_WRITER_TOKEN"],
                         {"content": "Stale REST fixture", "expectedRevision": updated["revision"]})
        assert status == 409 and conflict["error"]["code"] == "REVISION_CONFLICT"
        status, hidden = model_api("GET", "/api/v1/projects/" + project, os.environ["OIDC_SMOKE_OTHER_TENANT_TOKEN"])
        assert status == 404 and hidden["error"]["code"] == "PROJECT_NOT_FOUND"
        record("Authenticated REST project/artifact operations, writes, stale revision and tenant isolation")
        assert project not in {p["id"] for p in other.tool("model_projects")["projects"]}
        other.tool("model_artifact_get", {"project": project, "path": "requirements/test.txt"}, error=True)
        record("Different signed tenants cannot list or read each other's models")
        other.session = writer.session
        try:
            other.rpc("tools/list", {})
            raise AssertionError("Cross-principal session reuse accepted")
        except urllib.error.HTTPError as error:
            assert error.code in (400, 404)
        record("Cross-principal MCP session reuse rejected")
        for bearer in ("invalid", os.environ["OIDC_SMOKE_WRITER_TOKEN"] + "tampered"):
            try:
                initialize(module.Client(args.url, bearer=bearer))
                raise AssertionError("Invalid bearer accepted")
            except urllib.error.HTTPError as error:
                assert error.code == 401
        record("Malformed and forged credentials rejected over HTTP")
        evidence["status"] = "PASS"
    finally:
        args.evidence.parent.mkdir(parents=True, exist_ok=True)
        args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence))


if __name__ == "__main__":
    main()
