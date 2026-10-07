#!/usr/bin/env python3
"""Validate GitHub-built image references without loading deployment credentials."""
import json
import re
import sys
from pathlib import Path


def render(revision, source, destination):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Invalid validated revision")
    records = {}
    for component in ("app", "chat", "ingress", "fhir"):
        item = json.loads((Path(source) / (component + ".json")).read_text())
        if item.get("service") != component or item.get("revision") != revision:
            raise ValueError("Image manifest revision mismatch")
        image = item.get("image", "")
        expected = r"ghcr\.io/czarmich/openehr-fhir-modeller-" + component + r"@sha256:[0-9a-f]{64}"
        if not isinstance(image, str) or not re.fullmatch(expected, image):
            raise ValueError("Image must use its expected GHCR repository and digest")
        records[component] = image
    Path(destination, "images.env").write_text("REVISION=" + revision + "\n" + "".join(
        name.upper() + "_IMAGE=" + image + "\n" for name, image in records.items()))
    Path(destination, "images.json").write_text(json.dumps({"revision": revision, "images": records}, indent=2) + "\n")


if __name__ == "__main__":
    render(*sys.argv[1:])
