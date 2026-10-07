# Development

Use Docker for PHP 8.4 and Composer; no host PHP is assumed.

```bash
make env
make build-dev
make install
make up-dev
make ci
python3 scripts/mcp-smoke.py
make conformance
```

The root Compose file defines app, ingress and the optional browser service. `.docker/docker-compose.dev.yml` mounts the source and adds optional node/inspector tooling. Development runs as UID 1000 and stores scratch models under `/tmp/development-models`; use production compose and its volume to test persistence. `make run-stdio` runs the same application without an HTTP listener. `make inspector` builds the optional inspector profile; it is not required to use the product.

Production builds cache Composer dependencies separately from application source; changing PHP or browser files only rebuilds the source and autoloader layers.

Configuration is documented in [CONFIGURATION.md](CONFIGURATION.md). `make ci` executes the requirement drift check, PHPStan level 8 and offline PHPUnit. Python is used only for an independent MCP integration client, not as a runtime or LLM dependency. Docker-only runtime refers to application maintenance; GitHub CI may install PHP on an ephemeral runner.

## Gotcha: MCP discovery cache

Discovery is cached under `$XDG_DATA_HOME/openehr-modelling-assistant/cache` (default `/tmp`). The namespace includes APP_VERSION and a capability revision. After changing capability attributes without a version change, recreate the app container or clear that cache in the development container. Sessions also live in the temporary data directory and expire; a restart requires client reinitialization. Persistent models use a separate configured path.
